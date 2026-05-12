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

    return {
      mutation: {
        type: mutationType,
        modified: {
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
        },
        syncMetadata: {
          relation: "user_cards",
        },
      },
      sign_skey: userData.sign_skey,
    };
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

    const signatureFields = {
      deleted_flag: del,
      owner_timestamp: ts,
      parent_sign_hash: parentSignHash,
      sign_hash: signHash,
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

    return {
      type: mutationType || (isDelete ? "update" : "insert"),
      modified: {
        user_hash: userHash,
        uuid,
        value_b64: valueB64,
        deleted_flag: del,
        owner_timestamp: ts,
        parent_sign_hash: parentSignHash,
        sign_hash: signHash,
        sign_b64: finalSignB64
      },
      syncMetadata: {
        relation: "user_storage",
      },
    };
  },
};
