import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { sha3_512 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

const encodeBase64 = (bytes, padded = false) => {
  if (!bytes) return "";
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const result = btoa(binary);
  return padded ? result : result.replace(/=+$/, "");
};

const encodeField = (key, value) => {
  if (value === null) return "null";
  if (key.endsWith("_cert") || key.endsWith("_pkey")) {
    return encodeBase64(value, true);
  }
  if (key.endsWith("_b64")) {
    return typeof value === 'string' ? value : encodeBase64(value, true);
  }
  if (key.endsWith("_hash")) {
    return value;
  }
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return value;
  return String(value);
};

const buildSignatureData = (fields) => {
  return Object.keys(fields)
    .sort()
    .map((key) => encodeField(key, fields[key]))
    .join("");
};

export const api = {
  ingest: (mutations) => {
    return fetch(`${ELECTRIC_API_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations }),
    });
  },

  ingestWithAuth: async (mutations, signSkey) => {
    const challengeResp = await api.getChallenge();
    const challengeSig = ml_dsa87.sign(new TextEncoder().encode(challengeResp.challenge), signSkey);
    const signature = encodeBase64(challengeSig);

    return fetch(`${ELECTRIC_API_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: {
          challenge_id: challengeResp.challenge_id,
          signature,
        },
        mutations,
      }),
    });
  },

  ingestWithAuthEach: async (mutations, signSkey) => {
    const challengeResp = await api.getChallenge();
    const challengeSig = ml_dsa87.sign(new TextEncoder().encode(challengeResp.challenge), signSkey);
    const signature = encodeBase64(challengeSig);

    return fetch(`${ELECTRIC_API_URL}/ingest_each`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: {
          challenge_id: challengeResp.challenge_id,
          signature,
        },
        mutations,
      }),
    });
  },

  getChallenge: async () => {
    const resp = await fetch(`${ELECTRIC_API_URL}/challenge`, {
      headers: { accept: "application/json" },
    });
    return resp.json();
  },

  createUserCard: (
    name,
    userData,
    mutationType = 'insert',
  ) => {
    const ownerTimestamp = Math.floor(Date.now() / 1000);
    const deletedFlag = false;

    const signatureFields = {
      contact_cert: userData.contact_cert,
      contact_pkey: userData.contact_pkey,
      crypt_cert: userData.crypt_cert,
      crypt_pkey: userData.crypt_pkey,
      deleted_flag: deletedFlag,
      name,
      owner_timestamp: ownerTimestamp,
      sign_pkey: userData.sign_pkey,
      user_hash: userData.user_hash,
    };

    const signatureData = buildSignatureData(signatureFields);
    const signB64 = ml_dsa87.sign(new TextEncoder().encode(signatureData), userData.sign_skey);

    const modified = {
      user_hash: userData.user_hash,
      sign_pkey: encodeBase64(userData.sign_pkey, true),
      contact_pkey: encodeBase64(userData.contact_pkey, true),
      contact_cert: encodeBase64(userData.contact_cert, true),
      crypt_pkey: encodeBase64(userData.crypt_pkey, true),
      crypt_cert: encodeBase64(userData.crypt_cert, true),
      name,
      deleted_flag: deletedFlag,
      owner_timestamp: ownerTimestamp,
      sign_b64: encodeBase64(signB64, true),
    };

    const mutation = mutationType === 'insert'
      ? { type: mutationType, modified, syncMetadata: { relation: "user_cards" } }
      : { type: mutationType, original: { user_hash: userData.user_hash }, changes: modified, syncMetadata: { relation: "user_cards" } };

    return { mutation, sign_skey: userData.sign_skey };
  },

  createStorageMutation: (
    userHash,
    uuid,
    valueB64,
    hashB64,
    version,
    ownerTimestamp,
    signSkey,
    isDelete = false,
    deletedFlag = false,
    parentSignHash = null,
    signHash = null,
    existingSignB64 = null,
    mutationType = null,
  ) => {
    const ts = ownerTimestamp || Math.floor(Date.now() / 1000);
    const del = isDelete || deletedFlag;

    // Must mirror the server's Signable impl for UserStorage, which drops
    // sign_b64 and sign_hash before building the payload — including
    // sign_hash here produced "invalid_signature" on every write.
    const signatureFields = {
      deleted_flag: del,
      owner_timestamp: ts,
      parent_sign_hash: parentSignHash,
      user_hash: userHash,
      uuid: uuid,
      value_b64: valueB64,
    };

    const signatureData = buildSignatureData(signatureFields);
    let finalSignB64 = existingSignB64;

    if (!finalSignB64 && signSkey) {
        const signBytes = ml_dsa87.sign(new TextEncoder().encode(signatureData), signSkey);
        finalSignB64 = encodeBase64(signBytes, true);
    }

    // The server requires sign_hash: "uss_" + SHA3-512 of the raw signature
    // bytes (same derivation dialog rows use, with their own prefix).
    let finalSignHash = signHash;
    if (!finalSignHash && finalSignB64) {
      const decodedSign = Uint8Array.from(atob(finalSignB64), c => c.charCodeAt(0));
      finalSignHash = "uss_" + bytesToHex(sha3_512(decodedSign));
    }

    // Server schema fields only — hash_b64 is a local convenience and is
    // neither part of the server row nor of the signature payload.
    const changes = {
      user_hash: userHash,
      uuid,
      value_b64: valueB64,
      deleted_flag: del,
      owner_timestamp: ts,
      parent_sign_hash: parentSignHash,
      sign_hash: finalSignHash,
      sign_b64: finalSignB64
    };

    const type = mutationType || (isDelete ? "update" : "insert");

    return type === 'insert'
      ? { type, modified: changes, syncMetadata: { relation: "user_storage" } }
      : { type, original: { user_hash: userHash, uuid }, changes, syncMetadata: { relation: "user_storage" } };
  },

  createGenericMutation: (
    relation,
    row,
    signSkey,
    mutationType = "insert"
  ) => {
    const LOCAL_ONLY = ['operation', 'changed_at', 'sign_b64', 'sign_hash',
                        'modified_columns', 'sent_to_server', 'created_at', 'updated_at'];

    const CHECK_FIELDS = {
      dialog_keys: ['dialog_hash', 'sender_hash'],
      dialog_messages: ['message_id', 'sender_hash', 'dialog_hash'],
      dialog_messages_versions: ['message_id', 'sign_hash'],
      dialog_message_reactions: ['reaction_hash', 'reactor_hash', 'dialog_hash', 'message_id'],
      dialog_message_receipts: ['receipt_hash', 'peer_hash', 'dialog_hash', 'message_id'],
    };

    const fieldsToSign = {};
    for (const [key, value] of Object.entries(row)) {
      if (!LOCAL_ONLY.includes(key)) {
        fieldsToSign[key] = value;
      }
    }

    let finalSignB64 = row.sign_b64;
    if (signSkey) {
      const signatureData = buildSignatureData(fieldsToSign);
      const signBytes = ml_dsa87.sign(new TextEncoder().encode(signatureData), signSkey);
      finalSignB64 = encodeBase64(signBytes, true);
    }

    const changes = { ...fieldsToSign, sign_b64: finalSignB64 };
    if (finalSignB64) {
      const decodedSign = Uint8Array.from(atob(finalSignB64), c => c.charCodeAt(0));
      changes.sign_hash = "dms_" + bytesToHex(sha3_512(decodedSign));
    }

    if (mutationType === 'insert') {
      return { type: 'insert', modified: changes, syncMetadata: { relation } };
    }

    const original = {};
    for (const f of CHECK_FIELDS[relation] || []) {
      if (row[f] !== undefined) original[f] = row[f];
    }

    return { type: 'update', original, changes, syncMetadata: { relation } };
  },
};
