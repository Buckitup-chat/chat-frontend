# User Storage slots in the frontend

Address derivation, encryption and slot resolution are maintained in the
[SDK slot documentation](https://github.com/Buckitup-chat/pq-library/blob/main/docs/storage-slots.md).
The frontend obtains slot addresses through the installed SDK.
`EncryptionManagerPQ.js` supplies the current account and storage callbacks.
`userStorage.ts`, `storageIntent.ts` and `userStorageBase.ts` retain durable
intents, pending/accepted bases, app merge policies and outbox delivery.
Collections remain scoped to the active account and are disposed on logout.
See [SDK integration](../README.md#protocol-sdk).
