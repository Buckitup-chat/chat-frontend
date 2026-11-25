import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { contactAccessView, type ContactAccessSnapshot } from '@buckitup/pq-client/contactAccess';
import { contactAccess } from '@/lib/data/contactVouches';
import { onIntentChange } from '@/lib/data/intents';
import { onOutboxChange } from '@/lib/data/outbox';

export interface AccessContext {
	issuerHash: string;
	subjectHash: string;
	deviceId: string;
}

export type RequestAccess = (issuerHash: string, subjectHash: string, granted: boolean, deviceId: string) => Promise<unknown>;

const PENDING_POLL_MS = 3_000;

export function useContactStorageAccess(issuerHash: Ref<string | null>, subjectHash: Ref<string | null>, request: RequestAccess) {
	const snapshot = ref<ContactAccessSnapshot | null>(null);
	const submitting = ref<{ granted: boolean } | null>(null);
	const error = ref<string | null>(null);
	let generation = 0;
	let disposed = false;
	let poll: ReturnType<typeof setTimeout> | null = null;

	const stopPolling = () => {
		if (poll) clearTimeout(poll);
		poll = null;
	};

	const current = computed(() => {
		const snap = snapshot.value;
		return snap && snap.issuerHash === issuerHash.value && snap.subjectHash === subjectHash.value ? snap : null;
	});

	const view = computed(() => contactAccessView(current.value, { submitting: submitting.value }));

	const refresh = async (): Promise<void> => {
		const issuer = issuerHash.value;
		const subject = subjectHash.value;
		const mine = ++generation;
		stopPolling();
		if (!issuer || !subject) {
			snapshot.value = null;
			return;
		}
		const next = await contactAccess.snapshot(issuer, subject);
		if (mine !== generation) return;
		snapshot.value = next;
		if (view.value.pending) poll = setTimeout(() => void refresh(), PENDING_POLL_MS);
	};

	const context = (): AccessContext | null => {
		const snap = current.value;
		if (disposed || !snap?.identity) return null;
		return { issuerHash: snap.issuerHash, subjectHash: snap.subjectHash, deviceId: snap.identity.deviceId };
	};

	const stillIn = (expected: AccessContext) => {
		const now = context();
		return !!now && now.issuerHash === expected.issuerHash && now.subjectHash === expected.subjectHash && now.deviceId === expected.deviceId;
	};

	const set = async (granted: boolean, expected: AccessContext): Promise<boolean> => {
		if (view.value.pending || !stillIn(expected)) return false;
		submitting.value = { granted };
		error.value = null;
		try {
			await request(expected.issuerHash, expected.subjectHash, granted, expected.deviceId);
		} catch {
			if (stillIn(expected)) error.value = 'The change could not be saved on this device. Nothing was sent.';
		} finally {
			submitting.value = null;
		}
		if (!disposed) await refresh();
		return true;
	};

	const notify = (userHash: string) => {
		if (userHash === issuerHash.value) void refresh();
	};
	const unsubscribeIntents = onIntentChange(notify);
	const unsubscribeOutbox = onOutboxChange(notify);

	watch([issuerHash, subjectHash], () => {
		error.value = null;
		void refresh();
	}, { immediate: true });

	onScopeDispose(() => {
		disposed = true;
		generation++;
		stopPolling();
		unsubscribeIntents();
		unsubscribeOutbox();
	});

	return { view, error, context, stillIn, set, refresh };
}
