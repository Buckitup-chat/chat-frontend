// The addresses a handshake code offers (docs/task-handshake-pq2.md §5a): a
// pure function over what WebRTC gathered, handed to QWBP's selectCandidates
// hook (patches/qwbp+0.1.0.patch).
/* global RTCIceServer -- a DOM type */
import type { QWBPCandidate, QWBPGatheredCandidate } from 'qwbp';

/** QWBP's own cut, the first 4, can be all virtual networks on a computer running VMs or containers. */
export const MAX_ADDRESSES = 6;
/** An IPv6 address takes 19 bytes in the code against IPv4's 7; two keep C and D below B's density. */
export const MAX_IPV6 = 2;
/** The relay endpoint gives two URIs (UDP and TCP), and each gives one relay address. */
export const MAX_RELAYS = 2;

export type AddressKind = 'relay' | 'srflx' | 'host';

export interface OfferedAddress {
	/** What goes into the code: a relay address typed as srflx, as QWBP's format has no relay type. */
	candidate: QWBPCandidate;
	kind: AddressKind;
}

const asOffered = (c: QWBPGatheredCandidate, kind: AddressKind): OfferedAddress => ({
	candidate: { ip: c.ip, port: c.port, type: kind === 'host' ? 'host' : 'srflx', protocol: 'udp' },
	kind,
});

/**
 * What a code offers: UDP only; the relay's addresses first (two at most),
 * then one STUN-found address — the relay answers STUN too — then the phone's
 * own; six at most, two of them IPv6 at most. A TCP candidate only repeats an
 * address the channel reaches over UDP anyway.
 *
 * `relayOnly` leaves everything but the relay out: a test switch, so that two
 * pages on one host connect through the relay (qwbpChannel.ts gates it).
 */
export const selectAddresses = (gathered: QWBPGatheredCandidate[], { relayOnly = false } = {}): OfferedAddress[] => {
	const udp = gathered.filter((c) => c.protocol === 'udp');
	const ofType = (type: QWBPGatheredCandidate['type']) => udp.filter((c) => c.type === type);
	let ipv6 = 0;
	return [
		...ofType('relay').slice(0, MAX_RELAYS).map((c) => asOffered(c, 'relay')),
		...(relayOnly ? [] : [
			...ofType('srflx').slice(0, 1).map((c) => asOffered(c, 'srflx')),
			...ofType('host').map((c) => asOffered(c, 'host')),
		]),
	]
		.filter((o) => !o.candidate.ip.includes(':') || ++ipv6 <= MAX_IPV6)
		.slice(0, MAX_ADDRESSES);
};

/** How many relay addresses a set of ICE servers yields: one per TURN URI, two at most. */
export const expectedRelays = (iceServers: RTCIceServer[]): number =>
	Math.min(
		MAX_RELAYS,
		iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => /^turns?:/i.test(u)).length,
	);

/**
 * QWBP's selectCandidates hook. The list is complete once every expected
 * relay address is in, with a STUN-found and a host address beside them;
 * until then it waits, and QWBP asks for the final list when gathering
 * completes or after 2 s. With no relay, nothing is worth waiting for past
 * the end of gathering, which on host addresses alone takes milliseconds.
 */
export const candidateSelector = (
	{ relays, relayOnly = false, onSelected }: { relays: number; relayOnly?: boolean; onSelected?: (offered: OfferedAddress[]) => void },
) => (gathered: QWBPGatheredCandidate[], final: boolean): QWBPCandidate[] | null => {
	const offered = selectAddresses(gathered, { relayOnly });
	const count = (kind: AddressKind) => offered.filter((o) => o.kind === kind).length;
	const complete = relays > 0 && count('relay') >= relays && (relayOnly || (count('srflx') > 0 && count('host') > 0));
	if (!final && !complete) return null;
	onSelected?.(offered);
	return offered.map((o) => o.candidate);
};
