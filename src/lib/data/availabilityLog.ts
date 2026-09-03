// Local backfill journal per file (screen 05, "Ход добора").
//
// The protocol does not record when chunks reached this node — chunk rows
// carry the uploader's signing time, not arrival time — so the only honest
// history is what this client observed: every availability check that showed
// MORE chunks than the previous one gets a line. Module-scoped, so the
// journal survives dialog switches; deliberately not persisted — it narrates
// this session's observations, not a claim about the network's past.

export interface BackfillEvent {
	at: number; // unix seconds
	present: number;
	total: number;
}

const logs = new Map<string, BackfillEvent[]>();

export const recordAvailability = (fileId: string, present: number, total: number): void => {
	const log = logs.get(fileId) ?? [];
	const last = log[log.length - 1];
	// Only growth is an event; repeat polls with the same count are noise.
	if (last && last.present === present && last.total === total) return;
	log.push({ at: Math.floor(Date.now() / 1000), present, total });
	logs.set(fileId, log);
};

export const backfillLog = (fileId: string): BackfillEvent[] => logs.get(fileId) ?? [];
