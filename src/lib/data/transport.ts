// The app's connection to its server: @buckitup/pq-client's transport, at the
// base this build was made for (ELECTRIC_API_URL, defined by vite.config.js).
import { createTransport } from '@buckitup/pq-client/transport';

declare const ELECTRIC_API_URL: string;

export const transport = createTransport({
	baseUrl: typeof ELECTRIC_API_URL !== 'undefined' ? ELECTRIC_API_URL : '/api',
});
