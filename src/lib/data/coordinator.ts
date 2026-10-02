import { contractFor, entityKeyOf, OWNER_FIELD } from './writeContracts';
import { awaitShapeVisibility, collectionForRelation, scopeForRelation } from './barrier';
import { markUnconfirmed, clearUnconfirmed, isUnconfirmed } from './staleBase';
import { recordAccepted } from './acceptedSnapshot';
import { getOwnObservedTails } from './ownObservedTails';
import {
	dependencyCandidates, dependencyBlockFor, DependencyDiscoveryError, scopeConfirmationGeneration, recordScopeConfirmed,
	type DependencyDiscoveryBlock, type DiscoveryOutcome,
	transitiveDependencyClosure, type OutboxEntry,
} from './outbox';
import type { SendResult } from './ingest';

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
	const entityKey = relation === 'dialog_keys' ? null : entityKeyOf(relation, row);
	return entityKey ? `${relation}:${entityKey}` : scopeForRelation(relation, row);
};

export interface DependencyDiscoveryOptions {
	observedKeys?: string[];
	freshnessChecked?: boolean;
	admission?: NonNullable<DependencyDiscoveryBlock['admission']>;
}

const admissionConfirmed = async (admission: NonNullable<DependencyDiscoveryBlock['admission']>): Promise<boolean> => {
	if (admission.generation === null || isUnconfirmed(admission.scope)) return false;
	try {
		return (await scopeConfirmationGeneration(admission.scope)) > admission.generation;
	} catch {
		return false;
	}
};

export async function discoverDependencies(
	mutations: unknown[],
	userHash: string,
	excludeIds?: string[],
	opts: DependencyDiscoveryOptions = {},
): Promise<DiscoveryOutcome> {
	const first = mutations[0] as MutationShape | undefined;
	const relation = first?.syncMetadata?.relation;
	if (!relation) return { kind: 'found', dependsOn: [] };
	const row = rowOf(first);

	const chained = contractFor(relation, first?.type).dependencyClass === 'chained';
	const cardOwner = relation !== 'user_cards' ? ownerOf(relation, row) : '';
	const dialogHash = relation !== 'dialog_keys' && DIALOG_RELATIONS.includes(relation) && typeof row?.dialog_hash === 'string'
		? row.dialog_hash
		: '';
	if (!chained && !cardOwner && !dialogHash) return { kind: 'found', dependsOn: [] };

	let admission: DependencyDiscoveryBlock['admission'];
	if (opts.admission) {
		if (!(await admissionConfirmed(opts.admission))) admission = opts.admission;
	} else if (chained && !opts.freshnessChecked) {
		const scope = scopeForRelation(relation, row);
		if (isUnconfirmed(scope)) {
			admission = { scope, generation: await scopeConfirmationGeneration(scope).catch(() => null) };
		}
	}
	const kind = opts.admission || admission ? 'admission' : 'discovery';

	let candidates: { entries: OutboxEntry[]; observedKeys: string[] };
	try {
		candidates = await dependencyCandidates(userHash, opts.observedKeys);
	} catch (e) {
		const observedKeys = opts.observedKeys ?? (e instanceof DependencyDiscoveryError ? e.observedKeys : null);
		return { kind: 'blocked', block: dependencyBlockFor(e, { kind, observedKeys, admission: admission ?? opts.admission }) };
	}
	if (admission) {
		return { kind: 'blocked', block: dependencyBlockFor(null, { kind, observedKeys: opts.observedKeys ?? candidates.observedKeys, admission }) };
	}

	const exclude = transitiveDependencyClosure(candidates.entries, excludeIds ?? []);
	const all = candidates.entries.filter((e) => !exclude.has(e.id));
	const deps = new Set<string>();

	const rowOfEntry = (e: OutboxEntry): Record<string, unknown> | null => rowOf(e.mutations[0] as MutationShape | undefined);

	if (chained) {
		const chainKey = chainKeyFor(relation, row);
		for (const e of all) {
			if (chainKeyFor(e.relation, rowOfEntry(e)) === chainKey) deps.add(e.id);
		}
	}

	if (cardOwner) {
		for (const e of all) {
			const entryType = (e.mutations[0] as MutationShape | undefined)?.type;
			if (e.relation === 'user_cards' && entryType === 'insert' && ownerOf('user_cards', rowOfEntry(e)) === cardOwner) {
				deps.add(e.id);
			}
		}
	}

	if (dialogHash) {
		for (const e of all) {
			if (e.relation === 'dialog_keys' && rowOfEntry(e)?.dialog_hash === dialogHash) deps.add(e.id);
		}
	}

	// A new message's refs_map cites the author's own revisions that are still
	// in this outbox (captureObservedTails reads it), and every peer parks a
	// message whose parent has not arrived. So the revisions it cites go
	// first; a queued message it does not cite stays independent (ADR §7.2).
	// The cited set is the one recorded when the message was composed — the
	// same map refs_map_b64 encrypts. Every composed message records it, so a
	// record that cannot be read while a queued message of the dialog could be
	// cited leaves the list unproven: blocked, never "cites nothing".
	if (relation === 'dialog_messages' && first?.type === 'insert' && typeof row?.message_id === 'string') {
		const citable = all.filter((e) => e.relation === 'dialog_messages' && e.status !== 'server_accepted_pending_reconcile'
			&& rowOfEntry(e)?.dialog_hash === dialogHash);
		if (citable.length > 0) {
			let cited: Record<string, string> | null = null;
			let readFailure: unknown = new DependencyDiscoveryError('discovery_error');
			try {
				cited = await getOwnObservedTails(row.message_id);
			} catch (e) {
				readFailure = e;
			}
			if (!cited) {
				const observedKeys = opts.observedKeys ?? candidates.observedKeys;
				return { kind: 'blocked', block: dependencyBlockFor(readFailure, { kind, observedKeys, admission: opts.admission }) };
			}
			for (const e of citable) {
				const entryRow = rowOfEntry(e);
				const id = entryRow?.message_id;
				if (typeof id === 'string' && Object.hasOwn(cited, id) && cited[id] === entryRow?.sign_hash) deps.add(e.id);
			}
		}
	}

	return { kind: 'found', dependsOn: [...deps] };
}

export async function confirmScope(scope: string): Promise<void> {
	try {
		await recordScopeConfirmed(scope);
	} catch (e) {
		console.warn('[coordinator] scope confirmation could not be recorded durably; the scope stays unconfirmed:', scope, e);
		return;
	}
	clearUnconfirmed(scope);
}

export async function reconcileAccepted(
	mutations: unknown[],
	result: unknown = null,
	opts: { recordAcceptedSnapshot?: boolean } = {}
): Promise<void> {
	const sendResult = result as SendResult | null;
	const first = mutations[0] as MutationShape | undefined;
	const relation = first?.syncMetadata?.relation;
	if (!relation) return;
	const row = first?.modified ?? first?.changes ?? null;

	const entityKey = entityKeyOf(relation, row);
	if (opts.recordAcceptedSnapshot !== false && row && entityKey) {
		const owner = ownerOf(relation, row);
		if (owner) {
			await recordAccepted(relation, entityKey, row, owner);
		}
	}

	if (sendResult) {
		const contract = contractFor(relation, first?.type);
		if (contract.confirmation === 'visible') {
			const visible = await awaitShapeVisibility(collectionForRelation(relation, row), sendResult.txids, relation);
			const scope = scopeForRelation(relation, row);
			if (visible) await confirmScope(scope);
			else markUnconfirmed(scope);
		}
	}
}
