// Surfaces that exist to build the community recovery scheme, not to be used
// for backing up an account: splitting a key by hand into raw Shamir fragments
// moved around by copy-paste. (The architecture teststand was the other one,
// and it is gone rather than gated.)
//
// Read in exactly one place, and it owns reachability rather than appearance:
// the modal registry (src/components/modal/registry.js). Screens that would
// render a button ask isModalAvailable instead of re-reading this flag, because
// a gate repeated per entry point is a gate that gets half-lifted.
//
// Deliberately the dev server and nothing else: a staging build is a public
// deployment, and these surfaces drive live Sepolia and the relayer from
// buttons.
export const SANDBOX_SURFACES = import.meta.env.DEV;
