# BuckitUp Chat — Frontend

Privacy-focused, end-to-end encrypted messenger. This repository contains the Vue 3 single-page application; it talks to the [BuckitUp backend](https://github.com/Buckitup-chat/chat) (Phoenix + Electric sync).

## Stack

- **Vue 3** (script setup) + **Vite**, **Pinia** stores, **vue-router**
- **ElectricSQL + TanStack DB** — server data streams in through Electric shapes into reactive in-memory collections (`src/lib/data/`); writes go out as signed mutations to `/ingest_each`
- **Yjs** (+ y-webrtc / y-websocket / y-indexeddb) — CRDT sync for messages
- **Post-quantum cryptography** — [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum), `@noble/secp256k1`, `@noble/hashes`
- **QR / WebRTC handshake** — device-to-device contact verification (`qwbp`, `qr-scanner`)
- **Bootstrap 5 + Sass** for UI

## Requirements

- Node.js >= 20
- npm (the repo is npm-only; `package-lock.json` is the single lockfile)

## Getting started

```bash
npm install --legacy-peer-deps
npm run dev            # dev server with /api proxy
```

Other scripts:

```bash
npm run build          # production build into dist/
npm run preview        # serve the production build locally
npm run lint           # ESLint over src/
npm run format         # Prettier over src/
npm test               # Vitest unit tests
```

### Environment

Build-time configuration is driven by the `DOMAIN` environment variable (see `vite.config.js`):

- unset — defaults to the production API (`buckitup.xyz`), app served from `/`
- `DOMAIN=localhost:4000` — local backend, API over `http://`, dev proxy enabled
- any other value — used as the API host, app served from `/app/`

## Project structure

```
src/
  api/          HTTP / IPFS / socket clients
  components/   Reusable Vue components (chat, modals, engines, providers)
  composables/  Vue composables (useMenu, useLoader, ...)
  libs/         Crypto & infrastructure modules (EncryptionManagerPQ, DialogCrypto, p2p, ...)
  router/       vue-router config
  store/        Pinia stores (user, dialogs, ...)
  lib/data/     Typed Electric/TanStack data layer (collections, ingest, local KV)
  utils/        Helpers
  views/        Route pages (auth, chats, rooms, contacts, backup, account, ...)
docs/           Architecture notes, invariants (docs/invariants.md), backlog, reports
netlify/        Netlify redirect function for SPA preview hosting
```

## Account recovery

Signing in on a second device goes through [docs/device-link.md](docs/device-link.md): the backup travels between the two devices under an ML-KEM session, started by the account holder from their own account page and checked by a code they compare on both screens. A person with any working device is better served by it than by a recovery.

The community backup (Security & Recovery → Community backup) seals the account under a 32-byte wrap key, stored in `user_storage` where the key alone finds it (`src/lib/recovery/vault.ts`), and only that key is split: one half among guardians the owner chose from their contacts, whose shares travel in the dialogs, the other among independent nodes, with a smart contract recording who asked for a recovery and who approved it. An account is recovered from the login page, **Recover with friends**: a temporary account on the new device, guardians who check ten words on a call and approve it on chain, the owner's timelock and veto, and the shares sent back once the window opens; the recovery ends in a reshare. See [docs/backup-recovery-overview.md](docs/backup-recovery-overview.md), [docs/backup-recovery-plan.md](docs/backup-recovery-plan.md) and the [RFC](https://github.com/Community-secret-sharing/backitup-smart-contracts/blob/main/RFC_COMPARTMENTED_RECOVERY_WITH_CONTRACT.md).

The encrypted local file export stays as well: the vault JSON under a password (PBKDF2-SHA-256, 600k → AES-256-GCM).

## Deployment

Pushing to `main` triggers `.github/workflows/deploy-staging.yml`: the staging server pulls the repo, builds the frontend, and embeds `dist/` into the Phoenix app (`priv/static/app`), then restarts the staging service. `netlify.toml` exists only for SPA preview hosting.

## Development conventions

- Read `docs/invariants.md` before changing sync, storage or crypto code — every rule there came from a real failure. `CLAUDE.md` in the repo root carries the same guidance for AI-assisted sessions.
- No one-off scripts in the repo root: recurring utilities live in `scripts/`, experiments stay out of git (history keeps everything if needed).
- Work notes and reports go to `docs/` or the PR description, not the repo root.
- Tests live in `tests/` and run via `npm test`.
