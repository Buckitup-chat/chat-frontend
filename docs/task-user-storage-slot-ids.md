# `user_storage` slot identifiers

An implementation task. It came out of a remark by the backend developer and is
checked against the spec (`chat/docs/pq/reqs/pq_user_storage.md`) and against
our own code.

## The problem

`user_storage` is a generic key-value store: a row's key is the pair
`(user_hash, uuid)`, the client invents the `uuid`, and the server knows nothing
about what a record means. We address the known slots with fixed constants
([userStorage.ts:27](../src/lib/data/userStorage.ts#L27)):

```ts
export const STORAGE_SLOTS = {
	profile:  '00000000-0000-4000-8000-000000000001',
	contacts: '00000000-0000-4000-8000-000000000002',
};
```

Two independent defects.

**1. The identifiers are the same for every account and predictable.** Reads
from `user_storage` are public — spec §2.2: *"Any user can read any storage
(read public), only owner can write"*. So with someone's `user_hash` anyone can
ask for `(…0001)` and learn: this user has a profile, here is its size, here is
when it last changed. The contents are encrypted — **the purpose of the record
and the history of its edits are not**. That is server-side metadata, which is
exactly the level where the CTO decision puts access control.

**2. They are magic constants with no registry.** Neither the spec nor the code
records anywhere that `…0001` is taken. Another feature or another client will
pick the same identifier and overwrite the profile.

Deriving from the slot name (`sha256("profile")`, the route taken in the
`feat/user-domain-…` branch) solves neither: the identifier is still identical
for everyone, and the `parent_sign_hash` chain ends up bound to a string that
can be renamed.

## The right pattern is already in our code

Avatars are stored the way the spec prescribes, and that is a ready model to
generalise
([EncryptionManagerPQ.js:654](../src/libs/EncryptionManagerPQ.js#L654)):

```js
const uuid = crypto.randomUUID();   // random, one per avatar
```

and the mapping "which avatar is mine" lives **inside** the profile — the
`avatarUuid` field of the decrypted value. The profile is already a registry;
what is missing is the same trick for the remaining slots and an unpredictable
address for the profile itself.

## The target scheme

**The root record is the profile**, at an address derived from the account
secret rather than from a name. It holds the map of the other slots.

```
profile uuid = uuidv8( HKDF(crypt_skey, "buckitup/user-storage-root/v1", "slot") )
```

Properties: unpredictable without `crypt_skey`, deterministic for the owner on
any device, and needing neither a registry in the vault nor a scan of strings.
Rotating `crypt_skey` in this protocol means changing identity, so the address
will not drift.

The root record's value is today's profile plus the slot map:

```json
{
  "name": "…", "notes": "…", "avatarUuid": "…",
  "slots": { "contacts": "0f8c…-…" }
}
```

Every other slot (`contacts`, and future ones) gets a **random** uuid when it is
first created and is found only through this map.

The uuid bytes: take the first 16 bytes of the HKDF output, set version 8
(`b[6] = (b[6] & 0x0f) | 0x80`) and the RFC 4122 variant
(`b[8] = (b[8] & 0x3f) | 0x80`), then format canonically. The server column is
`Ecto.UUID` and will not accept an arbitrary string.

## Changes by file

**`src/lib/data/userStorage.ts`**

- Remove `STORAGE_SLOTS` and `LEGACY_LABELS` (legacy slot names are no longer
  read).
- Add `deriveRootSlotUuid(cryptSkey): string` — the derivation above.
- Add a slot resolver split by path: `getSlotUuid(name): string | null` for
  reads, `null` when the slot does not exist; `ensureSlotUuid(name): string` for
  the write path, creating the uuid and the map when absent. The resolver caches
  the map for the session and drops the cache on logout.
- The local KV key (`kvKey`) currently carries the uuid in the clear; leave it —
  `secureStore` already hashes key names (`hashKeys: true`).

**`src/libs/EncryptionManagerPQ.js`** — five places touch the slots (`:505`,
`:559`, `:600`, `:619`, plus avatars at `:673`, `:697`). Replace
`STORAGE_SLOTS.profile` with the root-record resolver and `STORAGE_SLOTS.contacts`
with `getSlotUuid('contacts')`. Leave avatars alone: they are already correct.

**`src/lib/data/collections.ts`** — close the adjacent hole while here: the
`user_storage` shape is opened **without a filter**
(`params: { table: 'user_storage' }`,
[:107](../src/lib/data/collections.ts#L107)), so we sync the rows of every user
on the network. All our access goes to our own `user_hash`, so a
`where: user_hash = '<ours>'` filter is safe and removes the excess traffic at
the same time. The collection then has to be built lazily, after login, like the
dialog ones.

## Reading creates no records

The slot resolver writes nothing on the read path. The root uuid is computed
from `crypt_skey` and the record is read; if it is absent, that is the valid
state "no profile saved yet" and an empty result goes up.

The reason is not tidiness. Creating an empty root record on a read would mean:
a session that only looks produces a server row and spends an
`owner_timestamp`; two devices logging in for the first time race each other on
the `insert`. Worse, on the second device it is a way to **lose the profile**:
the shape has not delivered the existing row yet, `getServerState` honestly says
"absent", the empty record goes out with the current time — and the real
profile, written earlier with a smaller `owner_timestamp`, loses under LWW.

The root record appears only on the write path:

- **saving the profile** is itself the write of the root row, so no separate
  step is needed (at registration it is created right here);
- **the first write to a named slot** — generate a random uuid, write the slot
  row, then add the `name → uuid` pair to the root record's map. The order is
  mandatory: the map must not point at a row that does not exist yet, so the two
  writes need a `sendMutationsAndAwaitShape` barrier between them.

## Existing records

No migration is needed: backward compatibility of data is not required in this
project (invariant §1a). The slots at `…0001` / `…0002` are test data and can
simply be abandoned; legacy addresses are neither read nor deleted.

It follows that the leak through already-published predictable addresses needs
no fix either — the data behind them is test data.

## Edge cases

- **The vault is locked.** The root uuid needs `crypt_skey`, so slots do not
  resolve before login. That is already true for local storage (its encryption
  key comes from the same place), so no new limitation appears.
- **A race when creating a slot.** Two devices (or two tabs) can both fail to
  find `contacts` and generate different uuids. Writing the root map is
  serialised per slot only inside one client, so the loser creates an orphaned
  row. Resolution: after writing the map, re-read it through a barrier and, if
  someone else's uuid won, adopt it and mark your own row deleted.
- **The map is damaged or points at a missing row.** Do not silently create a
  new slot over it — that loses the current session's contacts. Report the error
  and leave the decision to the user.
- **The root record exists but holds no profile** (a partially written state) —
  treat it as "no profile" and keep the map.

## Tests

Each must fail without the corresponding fix.

1. Two different accounts produce **different** root uuids.
2. One account produces **the same** root uuid on a repeated derivation
   (emulating a second device).
3. The root uuid passes `Ecto.UUID` format validation (version 8, RFC 4122
   variant).
4. Reading the profile on an account with no root record **creates no** server
   rows and returns an empty result.
5. A slot missing from the map is created once under two concurrent requests.
6. The `user_storage` shape is requested with a filter on our own `user_hash`.

## Open questions

- **Avatar exchange** (backlog §2) may require reading someone else's
  `user_storage`. The shape filter would then widen, and the address of their
  avatar would have to be passed explicitly — probably through `user_cards`.
  Decide it together with that task.
- **Agree it with the parallel branch.** The remark applies to both
  implementations; the chosen scheme has to be shared, or an account created by
  one client will not find its slots in the other.
