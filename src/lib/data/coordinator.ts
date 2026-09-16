import { contractFor, OWNER_FIELD } from './writeContracts';
import { awaitShapeVisibility, collectionForRelation, scopeForRelation } from './barrier';
import { markUnconfirmed, clearUnconfirmed, assertFreshBase } from './staleBase';
import { recordAccepted } from './acceptedSnapshot';
import { pendingEntries, quarantinedEntries, type OutboxEntry } from './outbox';
import type { SendResult } from './ingest';

const ENTITY_KEY_FIELD: Record<string, string> = {
	dialog_messages: 'message_id',
	dialog_message_reactions: 'reaction_hash',
};

interface MutationShape {
	type?: string;
	modified?: Record<string, unknown>;
	changes?: Record<string, unknown>;
	syncMetadata?: { relation?: string };
}

const rowOf = (m: MutationShape | undefined): Record<string, unknown> | null => m?.modified ?? m?.changes ?? null;

const ownerOf = (relation: string | undefined, row: Record<string, unknown> | null): string => {
	const field = relation ? OWNER_FIELD[relation] : undefined;
	const value = field ? row?.[field] : undefined;
	return typeof value === 'string' ? value : '';
};

const DIALOG_RELATIONS = [
	'dialog_messages',
	'dialog_messages_versions',
	'dialog_message_reactions',
	'dialog_message_receipts',
];

const chainKeyFor = (relation: string, row: Record<string, unknown> | null): string => {
	if (relation === 'user_storage') {
		const userHash = row?.user_hash;
		const uuid = row?.uuid;
		if (typeof userHash === 'string' && typeof uuid === 'string') return `user_storage:${userHash}|${uuid}`;
	} else {
		const entityField = ENTITY_KEY_FIELD[relation];
		const entityKey = entityField ? row?.[entityField] : undefined;
		if (typeof entityKey === 'string' && entityKey) return `${relation}:${entityKey}`;
	}
	return scopeForRelation(relation, row);
};

export async function dependenciesFor(mutations: unknown[], userHash: string): Promise<string[]> {
	const first = mutations[0] as MutationShape | undefined;
	const relation = first?.syncMetadata?.relation;
	if (!relation) return [];
	const row = rowOf(first);
	const all = [...(await pendingEntries(userHash)), ...(await quarantinedEntries(userHash))];
	const deps = new Set<string>();

	const rowOfEntry = (e: OutboxEntry): Record<string, unknown> | null => rowOf(e.mutations[0] as MutationShape | undefined);

	if (contractFor(relation, first?.type).dependencyClass === 'chained') {
		const chainKey = chainKeyFor(relation, row);

		assertFreshBase(scopeForRelation(relation, row));

		for (const e of all) {
			if (chainKeyFor(e.relation, rowOfEntry(e)) === chainKey) deps.add(e.id);
		}
	}

	if (relation !== 'user_cards') {
		const owner = ownerOf(relation, row);
		if (owner) {
			for (const e of all) {
				if (e.relation === 'user_cards' && ownerOf('user_cards', rowOfEntry(e)) === owner) deps.add(e.id);
			}
		}
	}

	if (relation !== 'dialog_keys' && DIALOG_RELATIONS.includes(relation)) {
		const dialogHash = row?.dialog_hash;
		if (typeof dialogHash === 'string' && dialogHash) {
			for (const e of all) {
				if (e.relation === 'dialog_keys' && rowOfEntry(e)?.dialog_hash === dialogHash) deps.add(e.id);
			}
		}
	}

	return [...deps];
}

export async function dispatchMutations(
	mutations: unknown[],
	send: (mutations: unknown[]) => Promise<SendResult>
): Promise<SendResult> {
	const result = await send(mutations);

	const first = mutations[0] as MutationShape | undefined;
	const relation = first?.syncMetadata?.relation;
	if (relation) {
		const row = first?.modified ?? first?.changes ?? null;
		
		const entityField = ENTITY_KEY_FIELD[relation];
		const entityKey = entityField ? row?.[entityField] : undefined;
		if (row && typeof entityKey === 'string' && entityKey) {
			await recordAccepted(relation, entityKey, row);
		}

		const contract = contractFor(relation, first?.type);
		if (contract.confirmation === 'visible') {
			const visible = await awaitShapeVisibility(collectionForRelation(relation, row), result.txids, relation);
			const scope = scopeForRelation(relation, row);
			if (visible) clearUnconfirmed(scope);
			else markUnconfirmed(scope);
		}
	}
	return result;
}
