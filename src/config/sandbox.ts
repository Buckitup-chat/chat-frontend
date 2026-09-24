// Surfaces that exist to build the community recovery scheme, not to be used
// for backing up an account: the architecture teststand, and splitting a key by
// hand into raw Shamir fragments moved around by copy-paste.
//
// Read in exactly two places, and both own reachability rather than appearance:
// the route table (src/router) and the modal registry
// (src/components/modal/registry.js). Screens that would render a button ask
// those — router.hasRoute, isModalAvailable — instead of re-reading this flag,
// because a gate repeated per entry point is a gate that gets half-lifted.
//
// Deliberately the dev server and nothing else. A staging build is a public
// deployment, and a teststand that drives live Sepolia, the relayer and the
// custodian nodes from buttons does not belong on one.
export const SANDBOX_SURFACES = import.meta.env.DEV;
