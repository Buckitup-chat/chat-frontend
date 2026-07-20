# BuckitUp Chat — Frontend

Privacy-focused, end-to-end encrypted messenger. This repository contains the Vue 3 single-page application; it talks to the [BuckitUp backend](https://github.com/Buckitup-chat/chat) (Phoenix + Electric sync).

## Stack

- **Vue 3** (script setup) + **Vite**, **Pinia** stores, **vue-router**
- **ElectricSQL + PGlite** — local-first sync of user data (SQL in the browser)
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
  lib/testbed/  Node-based account recovery testbed (Compartmented Secret Sharing)
  router/       vue-router config
  store/        Pinia stores (user, dialogs, web3, ...)
  utils/        Helpers, local DB (PGlite) layer
  views/        Route pages (auth, chats, rooms, contacts, backup, account, ...)
docs/           Architecture notes (Livebook .livemd files)
netlify/        Netlify redirect function for SPA preview hosting
```

## Account recovery (status)

The account backup/recovery system is mid-migration:

- **Legacy flow** (Lit Protocol + IPFS/Infura) — deprecated: the old Lit network is offline and the flow is scheduled for removal.
- **New flow** — Compartmented Multi-Secret Sharing across helper contacts and independent nodes, with a smart-contract condition layer. See [docs/restoration.livemd](docs/restoration.livemd) and the [RFC](https://github.com/Community-secret-sharing/backitup-smart-contracts/blob/main/RFC_COMPARTMENTED_RECOVERY_WITH_CONTRACT.md); frontend integration lives in `src/lib/testbed/`.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy-staging.yml`: the staging server pulls the repo, builds the frontend, and embeds `dist/` into the Phoenix app (`priv/static/app`), then restarts the staging service. `netlify.toml` exists only for SPA preview hosting.

## Development conventions

- No one-off scripts in the repo root: recurring utilities live in `scripts/`, experiments stay out of git (history keeps everything if needed).
- Work notes and reports go to `docs/` or the PR description, not the repo root.
- Tests live in `tests/` and run via `npm test`.
