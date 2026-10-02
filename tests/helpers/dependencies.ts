import { discoverDependencies } from '@/lib/data/coordinator';

export async function foundDependencies(mutations: unknown[], userHash: string): Promise<string[]> {
	const outcome = await discoverDependencies(mutations, userHash);
	if (outcome.kind !== 'found') throw new Error(`dependency discovery blocked: ${outcome.block.reason}`);
	return outcome.dependsOn;
}
