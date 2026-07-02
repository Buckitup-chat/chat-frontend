import type { GuardianDevice } from './types';
import { TESTBED } from './config';
import { createGuardianKeypair, generateStealthAddress } from './crypto';

function storeKey(): string {
	return TESTBED.STORE_KEY;
}

export function loadGuardians(): GuardianDevice[] {
	try {
		const raw = localStorage.getItem(storeKey());
		return raw ? JSON.parse(raw) : [];
	} catch { return []; }
}

export function saveGuardians(list: GuardianDevice[]): void {
	localStorage.setItem(storeKey(), JSON.stringify(list));
}

export async function addGuardian(label: string): Promise<GuardianDevice> {
	const kp = await createGuardianKeypair(TESTBED.DEMO_PIN + label);
	const stealth = generateStealthAddress(kp.spendingPublicKey);
	const device: GuardianDevice = {
		id: crypto.randomUUID(),
		label,
		...kp,
		stealthAddress: stealth.address,
		stealthPublicKey: stealth.publicKey,
		ephemeralPubKey: stealth.ephemeralPubKey,
		registered: false,
	};
	const list = loadGuardians();
	list.push(device);
	saveGuardians(list);
	return device;
}

export function removeGuardian(id: string): void {
	const list = loadGuardians().filter(g => g.id !== id);
	saveGuardians(list);
}

export function clearGuardians(): void {
	localStorage.removeItem(storeKey());
}
