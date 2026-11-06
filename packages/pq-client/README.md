# @buckitup/pq-client

The BuckitUp post-quantum protocol as a library, without a UI framework:
canonical row payloads and their ML-DSA-87 signatures, user card and dialog row
verification, message content encoding, key derivations, the vault envelope,
device link, the optical handshake (PQ2), derived identities (notes to self),
and the HTTP transport to a server.

The BuckitUp web app is built on it, and so is a partner's client for a
BuckitUp server. The wire protocol it speaks is described in the backend
repository: `Buckitup-chat/chat`, `docs/pq/external_client.md` and
`docs/pq/reqs/`.

## Use

```sh
npm install @buckitup/pq-client
```

```ts
import { signFields, verifyFields } from '@buckitup/pq-client/signature';
import { verifyCard } from '@buckitup/pq-client/verifyCard';
import { createTransport } from '@buckitup/pq-client/transport';

const server = createTransport({ baseUrl: 'https://chat.example/electric/v1' });
const sign = (message: Uint8Array) => ml_dsa87.sign(message, signSkey);
const { status, results } = await server.ingestEach(mutations, sign);
```

Each module is its own entry point (`@buckitup/pq-client/<module>`), an ES2022
module that loads in Node and in any bundler.

## Develop

The sources live in `packages/pq-client/src` of `Buckitup-chat/chat-frontend`;
the app imports them directly through an alias, so a change is tested with
the app's suite (`npm test` at the repository root), including the golden
vectors that pin every derivation.

```sh
npm run build -w @buckitup/pq-client   # → packages/pq-client/dist, then loads each module in Node
```

## Licence

GPL-3.0-only, as the repository it lives in.
