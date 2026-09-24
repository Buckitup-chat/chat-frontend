import type { GuardianDevice } from './types';
import { TESTBED } from './config';
import { createGuardianKeypair, generateStealthAddress } from './crypto';
import { GUARDIANS_KEY, readStored, writeStored, removeStored } from './storage';

export function loadGuardians(): GuardianDevice[] {
	return readStored<GuardianDevice[]>(GUARDIANS_KEY, []);
}

export function saveGuardians(list: GuardianDevice[]): void {
	writeStored(GUARDIANS_KEY, list);
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
	removeStored(GUARDIANS_KEY);
}
