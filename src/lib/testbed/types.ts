export interface GuardianDevice {
	id: string;
	label: string;
	eoaPrivateKey: `0x${string}`;
	eoaAddress: `0x${string}`;
	spendingPrivateKey: `0x${string}`;
	spendingPublicKey: `0x${string}`;
	stealthAddress: `0x${string}`;
	stealthPublicKey: `0x${string}`;
	ephemeralPubKey: `0x${string}`;
	registered: boolean;
}

export interface TestbedBackup {
	id: string;
	payload: string;
	masterA: string;
	masterB: string;
	nodeShares: string[];
	helperShares: string[];
	guardianRefs: GuardianRef[];
	timestamp: number;
}

export interface GuardianRef {
	eoa: string;
	label: string;
	stealthAddress: string;
	ephemeralPubKey: string;
}

export interface SplitResult {
	masterA: string;
	masterB: string;
	nodeShares: string[];
	helperShares: string[];
	guardianRefs: GuardianRef[];
}

export interface BackupRecord {
	id: `0x${string}`;
	label: string;
	owner: `0x${string}`;
	ownerPrivateKey: `0x${string}`;
	K: `0x${string}`;
	friendsHalf?: `0x${string}`;
	threshold: number;
	nodeThreshold: number;
	version: number;
	guardians: GuardianRef[];
	payload: string;
}

export interface NodeRef {
	id: string;
	url: string;
}

export interface OwnerAccount {
	privateKey: `0x${string}`;
	address: `0x${string}`;
}

