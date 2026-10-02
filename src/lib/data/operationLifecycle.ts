import { readAcceptedRecord } from './acceptedSnapshot';
import { assertNever, type StoredRead } from './storedRead';
import { toBytes } from '@/lib/pq/signature';
import { SIGN_HASH_PREFIX, authorOf, verifyReplicatedRow, type RowVerification, type SignPkeyResolver } from './rowVerification';
import { entityKeyOf } from './writeContracts';

type Row = Record<string, unknown>;

export type ShapeObservation =
	| 'absent'          // no row for the entity yet
	| 'exact'           // this operation's revision
	| 'older'           // an earlier revision: the read model has not caught up
	| 'newer'           // a later revision is the tip now
	| 'other_revision'  // same owner_timestamp, another signature
	| 'foreign';

export type OperationLifecycle =
	| { phase: 'NOT_ACCEPTED' }
	| { phase: 'EVIDENCE_UNAVAILABLE'; reason: 'locked' | 'unavailable' }
	| { phase: 'SERVER_ACCEPTED'; accepted: Row; shape: Exclude<ShapeObservation, 'exact'> }
	| { phase: 'SHAPE_VISIBLE'; accepted: Row; row: Row; verification: Exclude<RowVerification, { status: 'verified' }> | null }
	| { phase: 'VERIFIED'; accepted: Row; row: Row };

const sameBytes = (a: unknown, b: unknown): boolean => {
	if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
	try {
		const x = toBytes(a);
		const y = toBytes(b);
		return x.length === y.length && x.every((byte, i) => byte === y[i]);
	} catch {
		return false;
	}
};

export function observeShapeRow(relation: string, ownerHash: string, accepted: Row, shapeRow: Row | null | undefined): ShapeObservation {
	if (!shapeRow) return 'absent';
	const key = entityKeyOf(relation, accepted);
	if (!key || entityKeyOf(relation, shapeRow) !== key) return 'foreign';
	if (authorOf(relation, shapeRow) !== ownerHash || authorOf(relation, accepted) !== ownerHash) return 'foreign';
	const shapeTs = Number(shapeRow.owner_timestamp);
	const acceptedTs = Number(accepted.owner_timestamp);
	if (shapeTs < acceptedTs) return 'older';
	if (shapeTs > acceptedTs) return 'newer';
	if (SIGN_HASH_PREFIX[relation] && (typeof accepted.sign_hash !== 'string' || shapeRow.sign_hash !== accepted.sign_hash)) {
		return 'other_revision';
	}
	return sameBytes(shapeRow.sign_b64, accepted.sign_b64) ? 'exact' : 'other_revision';
}

export function observeAcceptedOperation(relation: string, ownerHash: string, accepted: Row, shapeRow: Row | null | undefined): OperationLifecycle {
	const shape = observeShapeRow(relation, ownerHash, accepted, shapeRow);
	if (shape !== 'exact') return { phase: 'SERVER_ACCEPTED', accepted, shape };
	return { phase: 'SHAPE_VISIBLE', accepted, row: shapeRow!, verification: null };
}

export async function verifyAcceptedOperation(
	relation: string,
	ownerHash: string,
	accepted: Row,
	shapeRow: Row | null | undefined,
	resolveSignPkey: SignPkeyResolver,
): Promise<OperationLifecycle> {
	const observed = observeAcceptedOperation(relation, ownerHash, accepted, shapeRow);
	if (observed.phase !== 'SHAPE_VISIBLE') return observed;
	const verification = await verifyReplicatedRow(relation, observed.row, resolveSignPkey);
	return verification.status === 'verified'
		? { phase: 'VERIFIED', accepted, row: observed.row }
		: { ...observed, verification };
}

export function readAcceptedEvidence(relation: string, entityKey: string, ownerHash: string): Promise<StoredRead<Row>> {
	return readAcceptedRecord(relation, entityKey, ownerHash, {
		ownerOf: (row) => authorOf(relation, row),
		entityKeyOf: (row) => entityKeyOf(relation, row),
	});
}

export async function readAcceptedOperation(
	relation: string,
	entityKey: string,
	ownerHash: string,
	opts: { shapeRow: Row | null | undefined; resolveSignPkey: SignPkeyResolver },
): Promise<OperationLifecycle> {
	const read = await readAcceptedEvidence(relation, entityKey, ownerHash);
	switch (read.kind) {
		case 'missing': return { phase: 'NOT_ACCEPTED' };
		case 'locked': return { phase: 'EVIDENCE_UNAVAILABLE', reason: 'locked' };
		case 'corrupt':
		case 'unavailable': return { phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' };
		case 'present': break;
		default: return assertNever(read);
	}
	const accepted = read.row;
	return verifyAcceptedOperation(relation, ownerHash, accepted, opts.shapeRow, opts.resolveSignPkey);
}

export type ProjectionReplacement =
	| { replace: true; by: 'verified' | 'superseded'; lifecycle: OperationLifecycle }
	| { replace: false; lifecycle: OperationLifecycle };

export async function projectionReplacement(
	relation: string,
	entityKey: string,
	ownerHash: string,
	shapeRow: Row | null | undefined,
	resolveSignPkey: SignPkeyResolver,
): Promise<ProjectionReplacement> {
	const lifecycle = await readAcceptedOperation(relation, entityKey, ownerHash, { shapeRow, resolveSignPkey });
	if (lifecycle.phase === 'VERIFIED') return { replace: true, by: 'verified', lifecycle };
	if (lifecycle.phase === 'SERVER_ACCEPTED' && lifecycle.shape === 'newer' && shapeRow
		&& (await verifyReplicatedRow(relation, shapeRow, resolveSignPkey)).status === 'verified') {
		return { replace: true, by: 'superseded', lifecycle };
	}
	return { replace: false, lifecycle };
}
