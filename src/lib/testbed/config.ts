export const TESTBED = {
	NUM_NODES: 5,
	NODE_THRESHOLD: 3,
	NUM_HELPERS: 3,
	HELPER_THRESHOLD: 2,
	DEMO_PIN: 'testbed-42',
	STORE_KEY: 'testbed.guardians',
};

export const NETWORK = {
	chainId: 11155111,
	rpcUrl: 'https://eth-sepolia.public.blastapi.io',
	secretRecovery: '0xe6342a319AA534d15D0aFA5cd947a6aF0Bc423c3' as `0x${string}`,
	keyRegistry: '0x04FA3aa8A23501A70768E220A5Df684D6249EDe7' as `0x${string}`,
	relayerUrl: 'https://secret-recovery-production.up.railway.app',
	nodes: [
		{ id: 'node-a', url: 'https://node-a-production-b16b.up.railway.app' },
		{ id: 'node-b', url: 'https://node-b-production-991a.up.railway.app' },
		{ id: 'generous-essence', url: 'https://generous-essence-production.up.railway.app' },
	],
	nodeThreshold: 2,
	stealthScheme: 1,
};
