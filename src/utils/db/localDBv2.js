import { PGliteWorker } from "@electric-sql/pglite/worker";
import { electricSync } from "@electric-sql/pglite-sync";
import { live } from "@electric-sql/pglite/live";
import { sha3_512 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import schemaSQL from "./schemaV4.sql?raw";
import { api } from "../../api/client";
import { useOnlineStatus } from "../../composables/useOnlineStatus";

const TABLE_PKS = {
  user_cards: ['user_hash'],
  user_storage: ['user_hash', 'uuid'],
  dialog_keys: ['dialog_hash', 'sender_hash'],
  dialog_messages: ['message_id'],
  dialog_messages_versions: ['message_id', 'sign_hash'],
  dialog_message_reactions: ['reaction_hash'],
  dialog_message_receipts: ['receipt_hash'],
};

const isAlreadyExistsError = (r) => {
  if (r.status !== "error" || r.error !== "validation_failed") return false;
  return Object.values(r.details || {}).some(v =>
    Array.isArray(v) && v.some(msg => /has already been taken/i.test(msg))
  );
};

class LocalDBv2 {
  #getSignSkey = null;

  #tables = [
    { table: 'user_cards', factory: 'userCard' },
    { table: 'user_storage', factory: 'storage' },
    { table: 'dialog_keys', factory: 'generic' },
    { table: 'dialog_messages', factory: 'generic' },
    { table: 'dialog_messages_versions', factory: 'generic' },
    { table: 'dialog_message_reactions', factory: 'generic' },
    { table: 'dialog_message_receipts', factory: 'generic' },
  ];

  #initPromise = null;
  #syncPending = false;
  #syncTimeout = null;
  #failStreak = 0;
  #backoffUntil = 0;

  constructor() {
    this.isOnline = navigator.onLine;
    this.isLocalStash = false;
    this.db = null;
    this.syncEngine = null;
    this.syncEngineStreams = null;
    window.addEventListener('online', () => { this.isOnline = true; setTimeout(() => this.#triggerSync(), 300); });
    window.addEventListener('offline', () => { this.isOnline = false; });
  }

  setAuthProvider(getSignSkey) {
    this.#getSignSkey = getSignSkey;
    setTimeout(() => this.#triggerSync(), 200);
  }

  get instance() {
    return this.db;
  }

  async init() {
    if (this.db) return this.db;
    if (this.#initPromise) return this.#initPromise;

    console.time('DB init total');

    this.#initPromise = this.#doInit();
    return this.#initPromise;
  }

  async #doInit() {

    try {
      this.db = new PGliteWorker(
        new Worker(new URL("./pglite-worker.js?worker", import.meta.url), { type: "module" }),
        {
          extensions: {
            live,
            electric: electricSync({
              metadataSchema: "my_sync_metadata",
            }),
          },
        }
      );

      console.time('schema exec');
      await this.db.exec(schemaSQL);
      console.timeEnd('schema exec');

      console.time('sync init');
      await this.initAllSyncs();
      console.timeEnd('sync init');

      console.time('check stash');
      await this.checkLocalStash();
      console.timeEnd('check stash');

      console.timeEnd('DB init total');
    } catch (err) {
      console.error("DB init failed:", err);
      this.#initPromise = null;
    }

    return this.db;
  }

  async initAllSyncs() {
    if (this.syncEngine) return;

    if (localStorage.getItem('DISABLE_SYNC') === 'true') {
      console.log('Shape sync disabled via localStorage');
      return;
    }

    const { setOffline } = useOnlineStatus();
    const absUrl = (p) => {
      const u = `${ELECTRIC_API_URL}${p}`;
      return u.startsWith('http') ? u : `${location.origin}${u}`;
    };

    const criticalShapes = {
      user_cards: {
        shape: { url: absUrl('/user_card'), params: { table: 'user_cards' } },
        table: 'user_cards',
        primaryKey: ['user_hash'],
      },
      user_storage: {
        shape: { url: absUrl('/user_storage'), params: { table: 'user_storage' } },
        table: 'user_storage',
        primaryKey: ['user_hash', 'uuid'],
      },
    };

    const dialogShapes = {
      dialog_keys: {
        shape: { url: absUrl('/dialog_key'), params: { table: 'dialog_keys' } },
        table: 'dialog_keys',
        primaryKey: ['dialog_hash', 'sender_hash'],
      },
      dialog_messages: {
        shape: { url: absUrl('/dialog_message'), params: { table: 'dialog_messages' } },
        table: 'dialog_messages',
        primaryKey: ['message_id'],
      },
      dialog_message_reactions: {
        shape: { url: absUrl('/dialog_message_reaction'), params: { table: 'dialog_message_reactions' } },
        table: 'dialog_message_reactions',
        primaryKey: ['reaction_hash'],
      },
      dialog_message_receipts: {
        shape: { url: absUrl('/dialog_message_receipt'), params: { table: 'dialog_message_receipts' } },
        table: 'dialog_message_receipts',
        primaryKey: ['receipt_hash'],
      },
    };

    console.time('sync init');

    try {
      const sync = await this.db.electric.syncShapesToTables({
        shapes: criticalShapes,
        key: 'chat-critical',
        onInitialSync: () => {
          console.timeEnd('sync init');
          console.log(`[Phase 1: ${Object.keys(criticalShapes).length} shapes] initial sync done`);
          this.#initDialogSyncs(dialogShapes, setOffline);
          setTimeout(() => this.#triggerSync(), 500);
        },
        onError: (error) => {
          console.error('Phase 1 shape sync error:', error);
          setOffline();
        },
      });

      for (const shapeStream of Object.values(sync.streams)) {
        shapeStream.subscribe(() => {
          setTimeout(() => this.#triggerSync(), 1200);
        });
      }

      this.syncEngine = sync;
    } catch (e) {
      if (e.message.includes('Already syncing')) {
        console.log('Shapes already syncing');
      } else { throw e; }
    }
  }

  async #initDialogSyncs(shapes, setOffline) {
    try {
      const sync = await this.db.electric.syncShapesToTables({
        shapes,
        key: 'chat-dialog',
        onInitialSync: () => {
          console.log(`[Phase 2: ${Object.keys(shapes).length} shapes] initial sync done`);
        },
        onError: (error) => {
          console.error('Phase 2 shape sync error:', error);
          setOffline();
        },
      });

      for (const shapeStream of Object.values(sync.streams)) {
        shapeStream.subscribe(() => {
          setTimeout(() => this.#triggerSync(), 1200);
        });
      }
    } catch (e) {
      if (e.message.includes('Already syncing')) {
        console.log('Dialog shapes already syncing');
      } else { throw e; }
    }
  }

  async getUsers() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards WHERE NOT deleted_flag ORDER BY name`);
    return rows;
  }

  async getUser(userHash) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM user_cards WHERE user_hash = $1 AND NOT deleted_flag`,
      [userHash]
    );
    return rows[0] || null;
  }

  async getPendingChanges() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards WHERE modified_columns IS NOT NULL`);
    return rows;
  }

  async upsertUserLocal(userData) {
    const {
      user_hash,
      sign_pkey,
      crypt_pkey,
      crypt_cert,
      contact_pkey,
      contact_cert,
      name,
      deleted_flag = false,
      owner_timestamp,
      sign_b64
    } = userData;

    const changed = `user_cards.sign_pkey IS DISTINCT FROM EXCLUDED.sign_pkey
      OR user_cards.crypt_pkey IS DISTINCT FROM EXCLUDED.crypt_pkey
      OR user_cards.crypt_cert IS DISTINCT FROM EXCLUDED.crypt_cert
      OR user_cards.contact_pkey IS DISTINCT FROM EXCLUDED.contact_pkey
      OR user_cards.contact_cert IS DISTINCT FROM EXCLUDED.contact_cert
      OR user_cards.name IS DISTINCT FROM EXCLUDED.name
      OR user_cards.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
      OR user_cards.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR user_cards.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64`;

    await this.db.query(
      `INSERT INTO user_cards (
        user_hash, sign_pkey, crypt_pkey, crypt_cert,
        contact_pkey, contact_cert, name, deleted_flag, owner_timestamp, sign_b64,
        modified_columns, sent_to_server, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY['__all__'], FALSE, NOW())
      ON CONFLICT (user_hash) DO UPDATE SET
        sign_pkey     = EXCLUDED.sign_pkey,
        crypt_pkey    = EXCLUDED.crypt_pkey,
        crypt_cert   = EXCLUDED.crypt_cert,
        contact_pkey = EXCLUDED.contact_pkey,
        contact_cert = EXCLUDED.contact_cert,
        name       = EXCLUDED.name,
        deleted_flag = EXCLUDED.deleted_flag,
        owner_timestamp = EXCLUDED.owner_timestamp,
        sign_b64   = EXCLUDED.sign_b64,
        modified_columns = CASE WHEN ${changed} THEN ARRAY['__all__'] ELSE user_cards.modified_columns END,
        sent_to_server = CASE WHEN ${changed} THEN FALSE ELSE user_cards.sent_to_server END,
        updated_at = NOW()`,
      [user_hash, sign_pkey, crypt_pkey, crypt_cert, contact_pkey, contact_cert, name || "", deleted_flag, owner_timestamp, sign_b64]
    );

    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async markUserAsDeletedLocal(userHash) {
    await this.db.query(
      `INSERT INTO user_cards (user_hash, deleted_flag, modified_columns, sent_to_server, updated_at)
       VALUES ($1, TRUE, ARRAY['__all__'], FALSE, NOW())
       ON CONFLICT (user_hash) DO UPDATE SET
         deleted_flag = TRUE,
         modified_columns = CASE WHEN user_cards.deleted_flag = TRUE THEN user_cards.modified_columns ELSE ARRAY['__all__'] END,
         sent_to_server = CASE WHEN user_cards.deleted_flag = TRUE THEN user_cards.sent_to_server ELSE FALSE END,
         updated_at = NOW()`,
      [userHash]
    );

    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async getAllPendingChanges() {
    if (!this.db) return [];
    const all = [];
    for (const t of this.#tables) {
      const { rows } = await this.db.query(`SELECT * FROM ${t.table} WHERE modified_columns IS NOT NULL`);
      if (rows.length > 0) {
        all.push({ table: t, rows });
      }
    }
    return all;
  }

  async checkLocalStash() {
    if (!this.db) return;
    for (const t of this.#tables) {
      const { rows } = await this.db.query(`SELECT 1 FROM ${t.table} WHERE modified_columns IS NOT NULL LIMIT 1`);
      if (rows.length > 0) {
        this.isLocalStash = true;
        return;
      }
    }
    this.isLocalStash = false;
  }

  async sendAllPendingChanges(signSkey) {
    if (this.#syncPending) return;
    if (!navigator.onLine || !this.isLocalStash) return;
    if (!signSkey) { console.warn('sign_skey required'); return; }

    this.#syncPending = true;
    console.time('sendChanges');

    try {
      const mutations = [];
      let mutationCount = 0;

      const tableRows = await Promise.all(this.#tables.map(async (t) => {
        console.time(`  query ${t.table}`);
        const { rows } = await this.db.query(`SELECT * FROM ${t.table} WHERE modified_columns IS NOT NULL`);
        console.timeEnd(`  query ${t.table}`);
        return { t, rows };
      }));

      console.time('build mutations');
      for (const { t, rows } of tableRows) {
        if (rows.length === 0) continue;

        for (const row of rows) {
          if (++mutationCount % 50 === 0) await new Promise(r => setTimeout(r, 0));

          const v = this.validateMutation(row, t.table);
          if (!v.valid) {
            const pkCol = this.#getPkCol(t.table);
            const pkVal = row[pkCol];
            console.warn(`[localDB] Skipping invalid ${t.table} ${pkVal}: ${v.reason}`);
            await this.db.query(
              `UPDATE ${t.table} SET modified_columns = NULL, sent_to_server = TRUE WHERE ${pkCol} = $1`,
              [pkVal]
            );
            continue;
          }

          const mutationType = row.deleted_flag ? 'update' : 'insert';

          switch (t.factory) {
            case 'userCard':
              if (!row.sign_pkey || !row.contact_pkey || !row.crypt_pkey) {
                console.warn(`[localDB] Skipping mutation for ${row.user_hash} due to missing keys`);
                continue;
              }
              mutations.push(api.createUserCard(row.name || 'User', {
                user_hash: row.user_hash,
                sign_pkey: this.#base64ToArray(row.sign_pkey),
                contact_pkey: this.#base64ToArray(row.contact_pkey),
                contact_cert: this.#base64ToArray(row.contact_cert),
                crypt_pkey: this.#base64ToArray(row.crypt_pkey),
                crypt_cert: this.#base64ToArray(row.crypt_cert),
                sign_skey: signSkey,
              }, mutationType).mutation);
              break;

            case 'storage':
              mutations.push(api.createStorageMutation(
                row.user_hash, row.uuid, row.value_b64, row.hash_b64,
                row.version, row.owner_timestamp || Math.floor(Date.now() / 1000), signSkey,
                row.deleted_flag, row.deleted_flag,
                row.parent_sign_hash, row.sign_hash, row.sign_b64,
                mutationType
              ));
              break;

            case 'generic':
              mutations.push(api.createGenericMutation(t.table, row, signSkey, mutationType));
              break;
          }
        }
      }
      console.timeEnd('build mutations');

      if (mutations.length === 0) { this.isLocalStash = false; return; }

      console.time('http ingest');
      const resp = await api.ingestWithAuthEach(mutations, signSkey);
      console.timeEnd('http ingest');

      // The server reports per-row outcomes in the body even on 4xx —
      // always try to read them before declaring the whole batch failed.
      let body = null;
      try { body = await resp.json(); } catch { /* non-JSON body */ }

      if (!body || !Array.isArray(body.results)) {
        console.error(`[localDB] ingest HTTP ${resp.status}: no per-row results`);
        this.#registerSendFailure();
        return;
      }

      const allOk = body.results.every(r => r.status === "ok");

      if (allOk) {
        console.time('mark synced');
        await Promise.all(this.#tables.map(t =>
          this.db.query(`UPDATE ${t.table} SET modified_columns = NULL, sent_to_server = TRUE WHERE modified_columns IS NOT NULL`)
        ));
        console.timeEnd('mark synced');
        this.isLocalStash = false;
        this.#failStreak = 0;
        this.#backoffUntil = 0;
        console.log(`Sent ${mutations.length} pending changes (all ok)`);
      } else {
        await this.#applyIngestResults(mutations, body.results);
      }
    } catch (e) {
      console.warn('Sync failed:', e);
      this.#registerSendFailure();
    }
    finally { console.timeEnd('sendChanges'); this.#syncPending = false; }
  }

  // Row-level outcome handling. Success and already-exists rows are marked
  // synced; permanently rejected rows are quarantined so a single bad row
  // cannot poison every subsequent batch; the rest stay pending for retry.
  async #applyIngestResults(mutations, results) {
    let okCount = 0, existsCount = 0, quarantined = 0, toRetry = 0;

    for (const r of results) {
      const m = mutations[r.index];
      if (!m) continue;

      if (r.status === "ok" || isAlreadyExistsError(r)) {
        r.status === "ok" ? okCount++ : existsCount++;
        await this.#markRow(m, `modified_columns = NULL, sent_to_server = TRUE`);
      } else if (r.error === 'validation_failed') {
        quarantined++;
        console.error(`[localDB] Mutation ${r.index} permanently rejected, quarantined locally:`, JSON.stringify(r.details || r));
        // sent_to_server stays FALSE: the row remains local-only, visibly unsynced
        await this.#markRow(m, `modified_columns = NULL`);
      } else {
        toRetry++;
        console.warn(`[localDB] Mutation ${r.index} failed (will retry):`, r.error);
      }
    }

    if (toRetry === 0) {
      this.#failStreak = 0;
      this.#backoffUntil = 0;
    } else {
      this.#registerSendFailure();
    }

    await this.checkLocalStash();
    console.log(`Sent ${mutations.length} pending changes (${okCount} ok, ${existsCount} already-exists, ${quarantined} quarantined, ${toRetry} to retry)`);
  }

  async #markRow(m, setClause) {
    const rel = m.syncMetadata?.relation;
    if (!rel) return;
    const pkCols = TABLE_PKS[rel];
    if (!pkCols) return;
    const pkData = m.type === 'insert' ? m.modified : (m.original || {});
    const conds = pkCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
    await this.db.query(
      `UPDATE ${rel} SET ${setClause} WHERE ${conds}`,
      pkCols.map(c => pkData[c])
    );
  }

  #registerSendFailure() {
    this.#failStreak = Math.min(this.#failStreak + 1, 6);
    const delay = Math.min(5000 * 2 ** this.#failStreak, 300000);
    this.#backoffUntil = Date.now() + delay;
    console.warn(`[localDB] sync backoff ${Math.round(delay / 1000)}s (streak ${this.#failStreak})`);
  }

  #base64ToArray(base64) {
    if (!base64) return null;
    const binary = atob(base64);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  triggerSync() {
    this.#triggerSync();
  }

  #triggerSync() {
    if (!this.db || !navigator.onLine || !this.#getSignSkey) return;
    if (Date.now() < this.#backoffUntil) return;
    const skey = this.#getSignSkey();
    if (!skey) return;
    if (this.#syncPending) return;
    if (this.#syncTimeout) clearTimeout(this.#syncTimeout);
    this.#syncTimeout = setTimeout(() => {
      this.#syncTimeout = null;
      this.sendAllPendingChanges(skey);
    }, 100);
  }

  // ========== User Storage Methods ==========

  async getUserStorage(userHash, uuid) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM user_storage_latest WHERE user_hash = $1 AND uuid = $2`,
      [userHash, uuid]
    );
    return rows[0] || null;
  }

  async getAllUserStorages(userHash) {
    if (!this.db) return [];
    const { rows } = await this.db.query(
      `SELECT * FROM user_storage_latest WHERE user_hash = $1 ORDER BY updated_at DESC`,
      [userHash]
    );
    return rows;
  }

  async upsertUserStorage({ userHash, uuid, valueB64, hashB64 = null, deletedFlag = false, parentSignHash = null, signHash = null, ownerTimestamp = null, signB64 = null }) {
    if (!this.db) {
      console.error('DB not initialized');
      return;
    }

    try {
      const latest = await this.getUserStorage(userHash, uuid);
      const newVersion = latest ? Number(latest.version) + 1 : 0;

      await this.upsertStorageLocal({ userHash, uuid, valueB64, hashB64, version: newVersion, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64 });
    } catch (error) {
      console.error('Storage insert failed:', error);
    }
  }

  async deleteUserStorage(userHash, uuid) {
    if (!this.db) return;
    await this.markStorageForDeletion(userHash, uuid);
  }

  async upsertStorageLocal({ userHash, uuid, valueB64, hashB64, version, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64 }) {
    if (!this.db) return;
    const changed = `user_storage.value_b64 IS DISTINCT FROM EXCLUDED.value_b64
      OR user_storage.hash_b64 IS DISTINCT FROM EXCLUDED.hash_b64
      OR user_storage.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
      OR user_storage.parent_sign_hash IS DISTINCT FROM EXCLUDED.parent_sign_hash
      OR user_storage.sign_hash IS DISTINCT FROM EXCLUDED.sign_hash
      OR user_storage.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR user_storage.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64
      OR user_storage.version IS DISTINCT FROM EXCLUDED.version`;

    await this.db.query(
      `INSERT INTO user_storage (
            user_hash, uuid, version, value_b64, hash_b64, deleted_flag,
            parent_sign_hash, sign_hash, owner_timestamp, sign_b64,
            modified_columns, sent_to_server, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY['__all__'], FALSE, NOW())
        ON CONFLICT (user_hash, uuid) DO UPDATE SET
            value_b64 = EXCLUDED.value_b64,
            hash_b64 = EXCLUDED.hash_b64,
            deleted_flag = EXCLUDED.deleted_flag,
            parent_sign_hash = EXCLUDED.parent_sign_hash,
            sign_hash = EXCLUDED.sign_hash,
            owner_timestamp = EXCLUDED.owner_timestamp,
            sign_b64 = EXCLUDED.sign_b64,
            version = EXCLUDED.version,
            modified_columns = CASE WHEN ${changed} THEN ARRAY['__all__'] ELSE user_storage.modified_columns END,
            sent_to_server = CASE WHEN ${changed} THEN FALSE ELSE user_storage.sent_to_server END,
            updated_at = NOW()`,
      [userHash, uuid, version, valueB64, hashB64, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64]
    );
    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async markStorageForDeletion(userHash, uuid) {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO user_storage (user_hash, uuid, deleted_flag, modified_columns, sent_to_server, updated_at)
         VALUES ($1, $2, TRUE, ARRAY['__all__'], FALSE, NOW())
         ON CONFLICT (user_hash, uuid) DO UPDATE SET
            deleted_flag = TRUE,
            modified_columns = CASE WHEN user_storage.deleted_flag = TRUE THEN user_storage.modified_columns ELSE ARRAY['__all__'] END,
            sent_to_server = CASE WHEN user_storage.deleted_flag = TRUE THEN user_storage.sent_to_server ELSE FALSE END,
            updated_at = NOW()`,
      [userHash, uuid]
    );
    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  // ========== Dialog Upserts ==========

  async upsertDialogKeysLocal(data) {
    if (!this.db) return;
    const changed = `dialog_keys.peer_hash IS DISTINCT FROM EXCLUDED.peer_hash
      OR dialog_keys.peer_kem_wrap_key_b64 IS DISTINCT FROM EXCLUDED.peer_kem_wrap_key_b64
      OR dialog_keys.peer_wrapped_msg_key_b64 IS DISTINCT FROM EXCLUDED.peer_wrapped_msg_key_b64
      OR dialog_keys.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR dialog_keys.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
      OR dialog_keys.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64`;

    await this.db.query(
      `INSERT INTO dialog_keys (
              dialog_hash, sender_hash, peer_hash, peer_kem_wrap_key_b64, peer_wrapped_msg_key_b64,
              owner_timestamp, deleted_flag, sign_b64,
              modified_columns, sent_to_server, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY['__all__'], FALSE, NOW())
          ON CONFLICT (dialog_hash, sender_hash) DO UPDATE SET
              peer_hash = EXCLUDED.peer_hash,
              peer_kem_wrap_key_b64 = EXCLUDED.peer_kem_wrap_key_b64,
              peer_wrapped_msg_key_b64 = EXCLUDED.peer_wrapped_msg_key_b64,
              owner_timestamp = EXCLUDED.owner_timestamp,
              deleted_flag = EXCLUDED.deleted_flag,
              sign_b64 = EXCLUDED.sign_b64,
              modified_columns = CASE WHEN ${changed} THEN ARRAY['__all__'] ELSE dialog_keys.modified_columns END,
              sent_to_server = CASE WHEN ${changed} THEN FALSE ELSE dialog_keys.sent_to_server END,
              updated_at = NOW()`,
      [data.dialog_hash, data.sender_hash, data.peer_hash, data.peer_kem_wrap_key_b64, data.peer_wrapped_msg_key_b64,
      data.owner_timestamp, data.deleted_flag, data.sign_b64]
    );
    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async upsertDialogMessageLocal(data) {
    if (!this.db) return;

    const signHash = data.sign_hash || (data.sign_b64 ? "dms_" + bytesToHex(sha3_512(Uint8Array.from(atob(data.sign_b64), c => c.charCodeAt(0)))) : null);

    const msgChanged = `dialog_messages.content_b64 IS DISTINCT FROM EXCLUDED.content_b64
      OR dialog_messages.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
      OR dialog_messages.refs_map_b64 IS DISTINCT FROM EXCLUDED.refs_map_b64
      OR dialog_messages.parent_sign_hash IS DISTINCT FROM EXCLUDED.parent_sign_hash
      OR dialog_messages.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR dialog_messages.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64
      OR dialog_messages.sign_hash IS DISTINCT FROM EXCLUDED.sign_hash`;

    await this.db.query(
      `INSERT INTO dialog_messages (
              message_id, dialog_hash, sender_hash, content_b64, deleted_flag,
              refs_map_b64, parent_sign_hash, owner_timestamp, sign_b64, sign_hash,
              modified_columns, sent_to_server, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY['__all__'], FALSE, NOW())
          ON CONFLICT (message_id) DO UPDATE SET
              content_b64 = EXCLUDED.content_b64,
              deleted_flag = EXCLUDED.deleted_flag,
              refs_map_b64 = EXCLUDED.refs_map_b64,
              parent_sign_hash = EXCLUDED.parent_sign_hash,
              owner_timestamp = EXCLUDED.owner_timestamp,
              sign_b64 = EXCLUDED.sign_b64,
              sign_hash = EXCLUDED.sign_hash,
              modified_columns = CASE WHEN ${msgChanged} THEN ARRAY['__all__'] ELSE dialog_messages.modified_columns END,
              sent_to_server = CASE WHEN ${msgChanged} THEN FALSE ELSE dialog_messages.sent_to_server END,
              updated_at = NOW()`,
      [data.message_id, data.dialog_hash, data.sender_hash, data.content_b64, data.deleted_flag,
      data.refs_map_b64, data.parent_sign_hash, data.owner_timestamp, data.sign_b64, signHash]
    );

    if (signHash) {
      const versionChanged = `dialog_messages_versions.dialog_hash IS DISTINCT FROM EXCLUDED.dialog_hash
        OR dialog_messages_versions.sender_hash IS DISTINCT FROM EXCLUDED.sender_hash
        OR dialog_messages_versions.content_b64 IS DISTINCT FROM EXCLUDED.content_b64
        OR dialog_messages_versions.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
        OR dialog_messages_versions.refs_map_b64 IS DISTINCT FROM EXCLUDED.refs_map_b64
        OR dialog_messages_versions.parent_sign_hash IS DISTINCT FROM EXCLUDED.parent_sign_hash
        OR dialog_messages_versions.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
        OR dialog_messages_versions.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64`;

      await this.db.query(
        `INSERT INTO dialog_messages_versions (
                message_id, sign_hash, dialog_hash, sender_hash, content_b64, deleted_flag,
                refs_map_b64, parent_sign_hash, owner_timestamp, sign_b64,
                modified_columns, sent_to_server, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY['__all__'], FALSE, NOW())
            ON CONFLICT (message_id, sign_hash) DO UPDATE SET
                dialog_hash = EXCLUDED.dialog_hash,
                sender_hash = EXCLUDED.sender_hash,
                content_b64 = EXCLUDED.content_b64,
                deleted_flag = EXCLUDED.deleted_flag,
                refs_map_b64 = EXCLUDED.refs_map_b64,
                parent_sign_hash = EXCLUDED.parent_sign_hash,
                owner_timestamp = EXCLUDED.owner_timestamp,
                sign_b64 = EXCLUDED.sign_b64,
                modified_columns = CASE WHEN ${versionChanged} THEN ARRAY['__all__'] ELSE dialog_messages_versions.modified_columns END,
                sent_to_server = CASE WHEN ${versionChanged} THEN FALSE ELSE dialog_messages_versions.sent_to_server END,
                updated_at = NOW()`,
        [data.message_id, signHash, data.dialog_hash, data.sender_hash, data.content_b64, data.deleted_flag,
        data.refs_map_b64, data.parent_sign_hash, data.owner_timestamp, data.sign_b64]
      );
    }

    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async upsertDialogReactionLocal(data) {
    if (!this.db) return;
    const changed = `dialog_message_reactions.type_b64 IS DISTINCT FROM EXCLUDED.type_b64
      OR dialog_message_reactions.deleted_flag IS DISTINCT FROM EXCLUDED.deleted_flag
      OR dialog_message_reactions.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR dialog_message_reactions.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64`;

    await this.db.query(
      `INSERT INTO dialog_message_reactions (
              reaction_hash, dialog_hash, message_id, message_sign_hash, reactor_hash,
              type_b64, deleted_flag, owner_timestamp, sign_b64,
              modified_columns, sent_to_server, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY['__all__'], FALSE, NOW())
          ON CONFLICT (reaction_hash) DO UPDATE SET
              type_b64 = EXCLUDED.type_b64,
              deleted_flag = EXCLUDED.deleted_flag,
              owner_timestamp = EXCLUDED.owner_timestamp,
              sign_b64 = EXCLUDED.sign_b64,
              modified_columns = CASE WHEN ${changed} THEN ARRAY['__all__'] ELSE dialog_message_reactions.modified_columns END,
              sent_to_server = CASE WHEN ${changed} THEN FALSE ELSE dialog_message_reactions.sent_to_server END,
              updated_at = NOW()`,
      [data.reaction_hash, data.dialog_hash, data.message_id, data.message_sign_hash, data.reactor_hash,
      data.type_b64, data.deleted_flag, data.owner_timestamp, data.sign_b64]
    );
    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async upsertDialogReceiptLocal(data) {
    if (!this.db) return;
    const changed = `dialog_message_receipts.type IS DISTINCT FROM EXCLUDED.type
      OR dialog_message_receipts.message_sign_hash IS DISTINCT FROM EXCLUDED.message_sign_hash
      OR dialog_message_receipts.owner_timestamp IS DISTINCT FROM EXCLUDED.owner_timestamp
      OR dialog_message_receipts.sign_b64 IS DISTINCT FROM EXCLUDED.sign_b64`;

    await this.db.query(
      `INSERT INTO dialog_message_receipts (
              receipt_hash, dialog_hash, message_id, peer_hash, type,
              message_sign_hash, owner_timestamp, sign_b64,
              modified_columns, sent_to_server, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY['__all__'], FALSE, NOW())
          ON CONFLICT (receipt_hash) DO UPDATE SET
              type = EXCLUDED.type,
              message_sign_hash = EXCLUDED.message_sign_hash,
              owner_timestamp = EXCLUDED.owner_timestamp,
              sign_b64 = EXCLUDED.sign_b64,
              modified_columns = CASE WHEN ${changed} THEN ARRAY['__all__'] ELSE dialog_message_receipts.modified_columns END,
              sent_to_server = CASE WHEN ${changed} THEN FALSE ELSE dialog_message_receipts.sent_to_server END,
              updated_at = NOW()`,
      [data.receipt_hash, data.dialog_hash, data.message_id, data.peer_hash, data.type,
      data.message_sign_hash, data.owner_timestamp, data.sign_b64]
    );
    this.isLocalStash = true;
    setTimeout(() => this.#triggerSync(), 100);
  }

  async debugLocalState() {
    const users = await this.getUsers();
    const pending = await this.getAllPendingChanges();
    console.table({ syncedAndLocalView: users, pendingChanges: pending });
  }

  async cleanupBrokenReactions() {
    if (!this.db) return { updated: 0 };
    const { rows: before } = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM dialog_message_reactions
       WHERE modified_columns IS NOT NULL
         AND (message_sign_hash = '' OR message_sign_hash IS NULL)`
    );
    const { rows: updated } = await this.db.query(
      `UPDATE dialog_message_reactions
       SET modified_columns = NULL, sent_to_server = TRUE, updated_at = NOW()
       WHERE modified_columns IS NOT NULL
         AND (message_sign_hash = '' OR message_sign_hash IS NULL)
       RETURNING reaction_hash`
    );
    console.log(`[localDB] cleanupBrokenReactions: marked ${updated.length} broken reaction(s) as synced`);
    return { updated: updated.length, wasPending: before[0]?.n || 0 };
  }

  async cleanupStuckMutations() {
    if (!this.db) return { total: 0, byTable: {} };
    const result = { total: 0, byTable: {} };

    for (const t of this.#tables) {
      const { rows } = await this.db.query(
        `SELECT * FROM ${t.table} WHERE modified_columns IS NOT NULL`
      );
      if (rows.length === 0) continue;

      const pkCol = this.#getPkCol(t.table);
      const invalid = [];
      for (const row of rows) {
        const v = this.validateMutation(row, t.table);
        if (!v.valid) invalid.push({ pk: row[pkCol], reason: v.reason });
      }

      if (invalid.length > 0) {
        const pks = invalid.map(i => i.pk);
        for (const pk of pks) {
          await this.db.query(
            `UPDATE ${t.table} SET modified_columns = NULL, sent_to_server = TRUE, updated_at = NOW() WHERE ${pkCol} = $1`,
            [pk]
          );
        }
        result.byTable[t.table] = invalid;
        result.total += invalid.length;
      }
    }

    if (result.total > 0) {
      console.log(`[localDB] cleanupStuckMutations: cleared ${result.total} invalid mutation(s)`, result.byTable);
    }
    return result;
  }

  validateMutation(row, relation) {
    const checks = {
      dialog_message_reactions: () => {
        if (!row.message_sign_hash) return { valid: false, reason: 'empty message_sign_hash' };
        return { valid: true };
      },
      dialog_message_receipts: () => {
        if (!row.message_sign_hash) return { valid: false, reason: 'empty message_sign_hash' };
        return { valid: true };
      },
      dialog_messages: () => {
        if (!row.content_b64 && !row.deleted_flag) return { valid: false, reason: 'empty content_b64' };
        return { valid: true };
      },
      dialog_keys: () => {
        if (!row.peer_kem_wrap_key_b64) return { valid: false, reason: 'missing peer_kem_wrap_key_b64' };
        if (!row.peer_wrapped_msg_key_b64) return { valid: false, reason: 'missing peer_wrapped_msg_key_b64' };
        return { valid: true };
      },
      user_storage: () => {
        if (!row.value_b64 && !row.deleted_flag) return { valid: false, reason: 'empty value_b64' };
        return { valid: true };
      },
      user_cards: () => {
        if (!row.sign_pkey || !row.contact_pkey || !row.crypt_pkey) {
          return { valid: false, reason: 'missing keys' };
        }
        return { valid: true };
      },
    };
    return (checks[relation] || (() => ({ valid: true })))();
  }

  #getPkCol(table) {
    return {
      user_cards: 'user_hash',
      user_storage: 'uuid',
      dialog_keys: 'dialog_hash',
      dialog_messages: 'message_id',
      dialog_messages_versions: 'message_id',
      dialog_message_reactions: 'reaction_hash',
      dialog_message_receipts: 'receipt_hash',
    }[table] || 'id';
  }
}

export const localDB = new LocalDBv2();
if (typeof window !== 'undefined') window.localDB = localDB;
