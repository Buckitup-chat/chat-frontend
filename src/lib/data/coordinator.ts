import { contractFor } from './writeContracts';
import { awaitShapeVisibility, collectionForRelation, scopeForRelation } from './barrier';
import { markUnconfirmed, clearUnconfirmed } from './staleBase';
import type { SendResult } from './ingest';

interface MutationShape {
	type?: string;
	modified?: Record<string, unknown>;
	changes?: Record<string, unknown>;
	syncMetadata?: { relation?: string };
}

export async function dispatchMutations(
	mutations: unknown[],
	send: (mutations: unknown[]) => Promise<SendResult>
): Promise<SendResult> {
	const result = await send(mutations);

	const first = mutations[0] as MutationShape;
	const relation = first?.syncMetadata?.relation;
	if (relation) {
		const contract = contractFor(relation, first?.type);
		if (contract.confirmation === 'visible') {
			const row = first?.modified ?? first?.changes ?? null;
			const visible = await awaitShapeVisibility(collectionForRelation(relation, row), result.txids, relation);
			const scope = scopeForRelation(relation, row);
			if (visible) clearUnconfirmed(scope);
			else markUnconfirmed(scope);
		}
	}
	return result;
}
