# WebAuthn PRF probe

A standalone page that tells whether a device's passkeys support the WebAuthn
PRF extension (CTAP2 `hmac-secret`), and whether its output is stable. Its
reports fill the device support table for moving the app's key vault from
"seed in the passkey's `user.id`" to a key derived from PRF.

It is not the app: no account, no server. Challenges are random and nothing
is verified, as nothing signs in. The passkey it makes is a throwaway one
named `prf-probe-…` under the page's host (`rp.id` = `location.hostname`), with
a random `user.id` that holds no secret. The page never shows or stores a PRF
output: it shows the first 8 hex characters of the output's SHA-256, enough to
tell two outputs apart. The browser keeps only the last passkey's id and
creation time (`localStorage["prfProbe.credential"]`).

## Open it

**https://buckitup.xyz/app/sandbox/prf-probe/index.html**

The app's build (`npm run build`, script `build:sandbox:prf`) builds this page
into `dist/sandbox/prf-probe/`, so every deploy serves the current one. Keep
`index.html` in the address: the server answers any other path under `/app/`
with the app itself. The app's service worker leaves `/sandbox/` to the
network.

WebAuthn needs a secure context (https, or `localhost`) and a host name: an IP
address cannot be an RP ID. A passkey belongs to the host it was made on, so
passkeys made on staging and on a Pi do not see each other.

## Test by hand

1. **Create passkey with PRF** — confirm with fingerprint, face or PIN.
2. **Get with PRF (this passkey)** — twice. Both gets must show the same
   `first` fingerprint, and `first` ≠ `second`.
3. **Get with PRF (any passkey)** — the browser's own passkey list, no id given.
4. **Cross-device (phone via QR)**, on a computer — first make a passkey on
   the phone (open the same address there, step 1), then on the computer tap
   step 4: the browser shows a QR code, scan it with the phone. A passkey of
   the computer picked in this sheet counts as a local get.
5. **Copy report** — one line of JSON (environment, summary, every step with
   its error name and message), to paste into the support table. If copying
   fails, "Report JSON" at the bottom holds the same report.

What each step records:

| Step | Recorded |
|---|---|
| Create | `prf.enabled`, whether an output came back at create (and its fingerprint), `authenticatorAttachment`, transports, public key algorithm, credential id |
| Get | the credential picked, whether it is the stored one, attachment, fingerprints of `first` and `second`, output length |
| Any failure | `error.name` and `error.message` (`NotAllowedError`: cancelled, timed out or refused; `NotSupportedError`; `SecurityError`: wrong host; `NoStoredPasskey`: step 2 before step 1) |

The summary reads them: **PRF works** (outputs at get, stable, `first` ≠
`second`), **no PRF** (the passkey works but gives no output), or not known
yet. "Create output = get output" compares the output at create, where the
platform gives one, with later gets of the same passkey.

The environment block shows `isUserVerifyingPlatformAuthenticatorAvailable()`,
`isConditionalMediationAvailable()`, `getClientCapabilities()` as returned
(its `extension:prf` key on its own line), the platform and browser
(`userAgentData` where the browser has it) and the user agent.

## Develop

From the repository root:

```bash
npx vite --config sandbox/prf-probe/vite.config.ts --host     # dev server
npm run build:sandbox:prf                                      # → dist/sandbox/prf-probe
node sandbox/prf-probe/scripts/check.mjs                       # Chromium, virtual authenticator
npx tsc -p sandbox/prf-probe/tsconfig.json                     # types
```

The check serves the built page on `http://localhost`, adds Chrome's virtual
authenticator over CDP and runs three profiles: with PRF (create, two gets,
any-passkey get; same fingerprints, `first` ≠ `second`, the copied report
parses, only the id is stored), without PRF (the page says "no PRF", no
error), and failing steps (an error is shown and the next steps still work).
`PRF_PROBE_DIST` serves another build directory.

To open the dev server from a phone on the same network, serve it over HTTPS
with a host name the phone resolves (an IP address cannot be an RP ID):

```bash
PRF_CERT=/tmp/cert.pem PRF_KEY=/tmp/key.pem npx vite --config sandbox/prf-probe/vite.config.ts --host
```

Code: `src/main.ts` (all of it), `src/style.css` (the handshake sandbox's look).
