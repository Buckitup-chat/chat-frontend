// The app's connection to its server: @buckitup/pq-client's transport, at the
// base this build was made for (ELECTRIC_API_URL, defined by vite.config.js).
import { createTransport, isNoAnswer, TransportError } from '@buckitup/pq-client/transport';

declare const ELECTRIC_API_URL: string;

export const transport = createTransport({
	baseUrl: typeof ELECTRIC_API_URL !== 'undefined' ? ELECTRIC_API_URL : '/api',
});

/**
 * Whether a failed request got no answer at all — fetch failed or timed out:
 * a fact about connectivity. A server that answered, even with garbage or an
 * error, is not one.
 */
export const unanswered = (e: unknown): boolean => (e instanceof TransportError && e.network) || isNoAnswer(e);
