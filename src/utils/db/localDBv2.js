import { PGliteWorker } from "@electric-sql/pglite/worker";
import { electricSync } from "@electric-sql/pglite-sync";
import { live } from "@electric-sql/pglite/live";
import schemaSQL from "./schemaV3.sql?raw";
import { api } from "../../api/client";
import { useOnlineStatus } from "../../composables/useOnlineStatus";

class LocalDBv2 {
  #getSignSkey = null;

  constructor() {
    this.isOnline = navigator.onLine;
    this.isLocalStash = false;
    this.isLocalStorageStash = false;
    this.db = null;
    this.syncEngine = null;
    this.storageSyncEngine = null;
  }

  setAuthProvider(getSignSkey) {
    this.#getSignSkey = getSignSkey;
  }

  get instance() {
    return this.db;
  }

  async init() {
    if (this.db) return this.db;

    console.log("→ Starting DB initialization");

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

      await this.db.exec(schemaSQL);

      // Skip migrations - columns should now exist from previous runs
      // Schema already has new columns in CREATE TABLE

      await this.initSyncEngine();

      const pending = await this.getPendingChanges();

      this.isLocalStash = pending.length > 0;

      this.syncEngine.stream.subscribe(() => {
        console.debug("user_cards_synced shape updated");

        if (this.isLocalStash) {
          setTimeout(() => {
            if (this.#getSignSkey) {
              this.sendPendingChanges(this.#getSignSkey());
            }
          }, 1200);
        }
      });

      await this.initStorageSyncEngine();

      const storagePending = await this.getPendingStorageChanges();
      this.isLocalStorageStash = storagePending.length > 0;

      if (this.storageSyncEngine) {
        this.storageSyncEngine.stream.subscribe(() => {
          console.debug("user_storage_synced shape updated");

          if (this.isLocalStorageStash) {
            setTimeout(() => {
              if (this.#getSignSkey) {
                this.sendPendingStorageChanges(this.#getSignSkey());
              }
            }, 1200);
          }
        });
      }

      console.log("→ DB initialized");
    } catch (err) {
      console.error("DB init failed:", err);
    }

    return this.db;
  }

  async initSyncEngine() {
    // Skip if already syncing
    if (this.syncEngine) return;

    try {
      const { setOffline } = useOnlineStatus();
      this.syncEngine = await this.db.electric.syncShapeToTable({
        shape: {
          url: `${ELECTRIC_API_URL}/user_card`,
          params: {
            table: "user_cards",
          },
        },
        table: "user_cards_synced",
        primaryKey: ["user_hash"],
        shapeKey: "user_cards_public",
        onError: (error) => {
          console.error("Shape sync error:", error);
          setOffline();
        },
      });
    } catch (e) {
      if (e.message.includes('Already syncing')) {
        console.log('Shape sync already running');
      } else {
        throw e;
      }
    }
  }

  async initStorageSyncEngine() {
    if (this.storageSyncEngine) return;
    try {
      this.storageSyncEngine = await this.db.electric.syncShapeToTable({
        shape: {
          url: `${ELECTRIC_API_URL}/user_storage`,
          params: { table: "user_storage" }
        },
        table: "user_storage_synced", primaryKey: ["user_hash", "uuid"], shapeKey: "user_storage_public",
        onError: (e) => console.error('Storage sync error:', e),
      });
    } catch (e) { console.log('Storage sync init:', e.message); }
  }

  async getUsers() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards ORDER BY name`);
    return rows;
  }

  async getUser(userHash) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM user_cards WHERE user_hash = $1`,
      [userHash]
    );
    return rows[0] || null;
  }

  async getPendingChanges() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards_local`);
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

    await this.db.query(
      `
      INSERT INTO user_cards_local (
        user_hash, sign_pkey, crypt_pkey, crypt_cert,
        contact_pkey, contact_cert, name, deleted_flag, owner_timestamp, sign_b64, operation
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN EXISTS (SELECT 1 FROM user_cards_synced WHERE user_hash = $1) THEN 'update' ELSE 'insert' END)
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
        operation  = CASE WHEN EXISTS (SELECT 1 FROM user_cards_synced WHERE user_hash = $1) THEN 'update' ELSE 'insert' END,
        changed_at = NOW()
      `,
      [user_hash, sign_pkey, crypt_pkey, crypt_cert, contact_pkey, contact_cert, name || "", deleted_flag, owner_timestamp, sign_b64]
    );

    this.isLocalStash = true;
  }

  async markUserAsDeletedLocal(userHash) {
    await this.db.query(
      `
      INSERT INTO user_cards_local (user_hash, operation)
      VALUES ($1, 'delete')
      ON CONFLICT (user_hash) DO UPDATE SET
        operation   = 'delete',
        changed_at  = NOW()
      `,
      [userHash]
    );

    this.isLocalStash = true;
  }

  async sendPendingChanges(signSkey) {
    if (!navigator.onLine || !this.isLocalStash) return;
    if (!signSkey) {
      console.warn('sign_skey required');
      return;
    }

    const changes = await this.getPendingChanges();
    if (changes.length === 0) {
      this.isLocalStash = false;
      return;
    }

    const mutations = changes.map((row) => {
      if (!row.sign_pkey || !row.contact_pkey || !row.crypt_pkey) {
        console.warn(`[localDB] Skipping mutation for ${row.user_hash} due to missing keys:`, {
          hasSign: !!row.sign_pkey,
          hasContact: !!row.contact_pkey,
          hasCrypt: !!row.crypt_pkey
        });
        return null;
      }
      const m = api.createUserCard(row.name || 'User', {
        user_hash: row.user_hash,
        sign_pkey: this.#base64ToArray(row.sign_pkey),
        contact_pkey: this.#base64ToArray(row.contact_pkey),
        contact_cert: this.#base64ToArray(row.contact_cert),
        crypt_pkey: this.#base64ToArray(row.crypt_pkey),
        crypt_cert: this.#base64ToArray(row.crypt_cert),
        sign_skey: signSkey,
      }, row.operation);
      return m.mutation;
    }).filter(Boolean);

    try {
      const resp = await api.ingestWithAuth(mutations, signSkey);
      const txt = await resp.text();
      console.log('User mutations:', mutations.length, resp.status, txt);
      if (!resp.ok) { console.warn('Failed:', txt); return; }
      console.log(`Sent ${changes.length} user changes`);
    } catch (e) { console.warn('Sync failed:', e); }
  }

  #base64ToArray(base64) {
    if (!base64) return null;
    const binary = atob(base64);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
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

    console.log('Inserting user_storage:', { userHash, uuid, valueB64: valueB64?.slice(0, 20) + '...' });

    try {
      const latest = await this.getUserStorage(userHash, uuid);
      const newVersion = latest ? Number(latest.version) + 1 : 0;
      console.log('New version:', newVersion);

      await this.db.query(
        `INSERT INTO user_storage_synced (user_hash, uuid, version, value_b64, hash_b64, deleted_flag, parent_sign_hash, sign_hash, owner_timestamp, sign_b64) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [userHash, uuid, newVersion, valueB64, hashB64, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64]
      );
      console.log('Insert successful');

      await this.upsertStorageLocal({ userHash, uuid, valueB64, hashB64, version: newVersion, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64 });
    } catch (error) {
      console.error('Storage insert failed:', error);
    }
  }

  async deleteUserStorage(userHash, uuid) {
    if (!this.db) return;
    await this.db.query(
      `DELETE FROM user_storage_synced WHERE user_hash = $1 AND uuid = $2`,
      [userHash, uuid]
    );
    await this.markStorageForDeletion(userHash, uuid);
  }

  // ========== Pending Storage Changes ==========

  async getPendingStorageChanges() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_storage_local`);
    return rows;
  }

  async upsertStorageLocal({ userHash, uuid, valueB64, hashB64 = null, version = 0, deletedFlag = false, parentSignHash = null, signHash = null, ownerTimestamp = null, signB64 = null }) {
    if (!this.db) return;
    await this.db.query(
      `
      INSERT INTO user_storage_local (user_hash, uuid, value_b64, hash_b64, version, deleted_flag, parent_sign_hash, sign_hash, owner_timestamp, sign_b64, operation)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN EXISTS (SELECT 1 FROM user_storage_synced WHERE user_hash = $1 AND uuid = $2) THEN 'update' ELSE 'insert' END)
      ON CONFLICT (user_hash, uuid) DO UPDATE SET
        value_b64 = EXCLUDED.value_b64,
        hash_b64 = EXCLUDED.hash_b64,
        version = EXCLUDED.version,
        deleted_flag = EXCLUDED.deleted_flag,
        parent_sign_hash = EXCLUDED.parent_sign_hash,
        sign_hash = EXCLUDED.sign_hash,
        owner_timestamp = EXCLUDED.owner_timestamp,
        sign_b64 = EXCLUDED.sign_b64,
        operation = CASE WHEN EXISTS (SELECT 1 FROM user_storage_synced WHERE user_hash = $1 AND uuid = $2) THEN 'update' ELSE 'insert' END,
        changed_at = NOW()
      `,
      [userHash, uuid, valueB64, hashB64, version, deletedFlag, parentSignHash, signHash, ownerTimestamp, signB64]
    );
    this.isLocalStorageStash = true;
  }

  async markStorageForDeletion(userHash, uuid) {
    if (!this.db) return;
    await this.db.query(
      `
      INSERT INTO user_storage_local (user_hash, uuid, operation)
      VALUES ($1, $2, 'delete')
      ON CONFLICT (user_hash, uuid) DO UPDATE SET
        operation = 'delete',
        changed_at = NOW()
      `,
      [userHash, uuid]
    );
    this.isLocalStorageStash = true;
  }

  async sendPendingStorageChanges(signSkey) {
    if (!navigator.onLine || !this.isLocalStorageStash) return;
    if (!signSkey) { console.warn('sign_skey required'); return; }

    const changes = await this.getPendingStorageChanges();
    if (changes.length === 0) { this.isLocalStorageStash = false; return; }

    const mutations = changes.map(row => {
      if (row.operation === 'insert' || row.operation === 'update' || row.operation === 'delete') {
        const mutationType = row.operation === 'delete' ? 'update' : row.operation;
        return api.createStorageMutation(
          row.user_hash, row.uuid, row.value_b64, row.hash_b64,
          row.version, row.owner_timestamp || Math.floor(Date.now() / 1000), signSkey,
          row.operation === 'delete', row.deleted_flag || (row.operation === 'delete'),
          row.parent_sign_hash, row.sign_hash, row.sign_b64,
          mutationType
        );
      }
      return null;
    }).filter(Boolean);

    try {
      const resp = await api.ingestWithAuth(mutations, signSkey);
      const txt = await resp.text();
      console.log('Storage mutations:', mutations.length, resp.status, txt);
      if (!resp.ok) { console.warn('Failed:', txt); return; }
      console.log(`Sent ${changes.length} storage changes`);
    } catch (e) { console.warn('Sync failed:', e); }
  }

  async debugLocalState() {
    const users = await this.getUsers();
    const pending = await this.getPendingChanges();
    console.table({ syncedAndLocalView: users, pendingChanges: pending });
  }
}

export const localDB = new LocalDBv2();