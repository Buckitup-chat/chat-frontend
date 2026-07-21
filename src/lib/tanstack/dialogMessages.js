// PoC: Electric shape -> TanStack DB collection for one dialog's messages.
// Read path only: writes still go through the existing localDB push queue;
// sent rows arrive back here through the shape stream.
import { createCollection } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';

const collections = new Map();

const absUrl = (p) => {
	const u = `${ELECTRIC_API_URL}${p}`;
	return u.startsWith('http') ? u : `${location.origin}${u}`;
};

export function getDialogMessagesCollection(dialogHash) {
	let coll = collections.get(dialogHash);
	if (!coll) {
		coll = createCollection(
			electricCollectionOptions({
				id: `dm-${dialogHash.slice(0, 20)}`,
				shapeOptions: {
					// Client-controlled shape endpoint: table + where from query params
					url: absUrl('/shapes'),
					params: {
						table: 'dialog_messages',
						where: `dialog_hash = '${dialogHash}'`,
					},
					// @electric-sql/client >=1.5 pauses streams while document.hidden
					// (battery saver). Keep the PoC measurable in embedded/background
					// panes; revisit for production (pausing is usually desirable).
					runtimeVisibility: {
						getCurrentState: () => 'visible',
						subscribe: () => () => {},
					},
				},
				getKey: (row) => row.message_id,
			})
		);
		collections.set(dialogHash, coll);
	}
	return coll;
}
