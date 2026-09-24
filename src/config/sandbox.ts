// Splitting a key by hand into raw Shamir fragments moved around by copy-paste:
// scaffolding for the community recovery scheme, not a way to back up an
// account. It goes when that scheme lands (docs/backup-recovery-overview.md).
//
// The gate owns reachability rather than appearance, and lives in the modal
// registry (src/components/modal/registry.js). Screens that would render a
// button ask isModalAvailable instead of re-reading this flag, because a gate
// repeated per entry point is a gate that gets half-lifted.
//
// Deliberately the dev server and nothing else: a staging build is a public
// deployment, and this screen splits the vault JSON itself, so each fragment is
// part of the plaintext — unlike the local-file export, which splits nothing
// and seals under a derived key. It must not read there as an offered way to
// back up an account.
export const SANDBOX_SURFACES = import.meta.env.DEV;
