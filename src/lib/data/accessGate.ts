import { openSession } from './readSession';

interface BlockedShape {
	shape: string;
	blockedAt: number;
	probeInterval: number;
	probeTimer: ReturnType<typeof setTimeout> | null;
	waiters: Array<() => void>;
}

const blocked = new Map<string, BlockedShape>();
const listeners = new Set<() => void>();

const INITIAL_PROBE_MS = 15_000;
const MAX_PROBE_MS = 300_000;

// ---------- public API ----------

export function markShapeBlocked(shape: string): void {
	if (blocked.has(shape)) return;
	const entry: BlockedShape = {
		shape,
		blockedAt: Date.now(),
		probeInterval: INITIAL_PROBE_MS,
		probeTimer: null,
		waiters: [],
	};
	blocked.set(shape, entry);
	scheduleProbe(entry);
	notifyListeners();
}

export function markShapeUnblocked(shape: string): void {
	const entry = blocked.get(shape);
	if (!entry) return;
	if (entry.probeTimer) clearTimeout(entry.probeTimer);
	const waiters = entry.waiters.splice(0);
	blocked.delete(shape);
	for (const resolve of waiters) resolve();
	notifyListeners();
}

export function isShapeBlocked(shape: string): boolean {
	return blocked.has(shape);
}

export function hasBlockedShapes(): boolean {
	return blocked.size > 0;
}

export function blockedShapeNames(): string[] {
	return [...blocked.keys()];
}

export function onBlockedChange(handler: () => void): () => void {
	listeners.add(handler);
	return () => { listeners.delete(handler); };
}

export function waitForUnblock(shape: string): Promise<void> {
	const entry = blocked.get(shape);
	if (!entry) return Promise.resolve();
	return new Promise<void>((resolve) => {
		entry.waiters.push(resolve);
	});
}

export function probeAllBlocked(): void {
	for (const entry of blocked.values()) {
		if (entry.probeTimer) clearTimeout(entry.probeTimer);
		entry.probeTimer = null;
		void probeOne(entry);
	}
}

export function resetGate(): void {
	for (const entry of blocked.values()) {
		if (entry.probeTimer) clearTimeout(entry.probeTimer);
		const waiters = entry.waiters.splice(0);
		for (const resolve of waiters) resolve();
	}
	blocked.clear();
	notifyListeners();
}

// ---------- internals ----------

function notifyListeners(): void {
	for (const handler of listeners) {
		try { handler(); } catch (e) { console.warn('[accessGate] listener threw:', e); }
	}
}

function scheduleProbe(entry: BlockedShape): void {
	if (entry.probeTimer) clearTimeout(entry.probeTimer);
	entry.probeTimer = setTimeout(() => {
		entry.probeTimer = null;
		void probeOne(entry);
	}, entry.probeInterval);
}

async function probeOne(entry: BlockedShape): Promise<void> {
	if (!blocked.has(entry.shape)) return;
	try {
		const token = await openSession(entry.shape);
		if (token) {
			markShapeUnblocked(entry.shape);
			return;
		}
	} catch {
		// network error — will retry
	}
	if (!blocked.has(entry.shape)) return;
	entry.probeInterval = Math.min(entry.probeInterval * 2, MAX_PROBE_MS);
	scheduleProbe(entry);
}

// Re-probe on network reconnection and tab focus
if (typeof window !== 'undefined') {
	window.addEventListener('online', () => probeAllBlocked());
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') probeAllBlocked();
	});
}
