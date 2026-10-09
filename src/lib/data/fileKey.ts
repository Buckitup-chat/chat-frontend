// A file as the chat shows it: the sender of the message carrying it and its
// id. Only the sender's signatures speak for a file (fileIntegrity.ts), so a
// message from someone else naming the same file_id is another file — its
// state, its refusal and its cached bytes must not be this one's.
export const fileKey = (part: { uploaderHash?: string; fileId: string }): string => `${part.uploaderHash ?? ''}/${part.fileId}`;
