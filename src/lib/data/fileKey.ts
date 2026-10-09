// A file as the chat shows it: the sender of the message carrying it and its
// id. Only the sender's signatures speak for a file (fileIntegrity.ts), so a
// message from someone else naming the same file_id is another file — its
// state, its refusal and its cached bytes must not be this one's.
// Built once per part: the template asks for it on every render, and parts
// do not change after decryptMessageRow.
const keys = new WeakMap<object, string>();
export const fileKey = (part: { uploaderHash?: string; fileId: string }): string => {
	let key = keys.get(part);
	if (key === undefined) keys.set(part, (key = `${part.uploaderHash ?? ''}/${part.fileId}`));
	return key;
};
