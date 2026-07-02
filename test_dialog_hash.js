import { sha3_512 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

export function getDialogHash(userA, userB) {
    const sorted = [userA, userB].sort();
    const hash = sha3_512(new TextEncoder().encode(sorted[0] + sorted[1]));
    return "di_" + bytesToHex(hash);
}
