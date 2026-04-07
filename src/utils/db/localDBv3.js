// utils/db/localDBv2.js
import { PGliteWorker } from "@electric-sql/pglite/worker";
import { electricSync } from "@electric-sql/pglite-sync";
import { live } from "@electric-sql/pglite/live";
import schemaSQL from "./schemaV3.sql?raw";
import { api } from "../../api/client";
import { useOnlineStatus } from "../../composables/useOnlineStatus";

class LocalDB {
  #db = null;
  #syncEngine = null;
  #isInitialized = false;
  #initPromise = null;

  isLocalStash = false;

  async init() {
    if (this.#isInitialized) return this.#db;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = this.#performInit();
    this.#db = await this.#initPromise;
    return this.#db;
  }

  async #performInit() {
    console.log('→ Initializing PGlite + Electric...');

    this.#db = new PGliteWorker(
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

    // Завантажуємо нову схему
    await this.#db.exec(schemaSQL);

    await this.#initSyncEngine();

    const pending = await this.getPendingChanges();
    this.isLocalStash = pending.length > 0;

    this.#isInitialized = true;
    console.log('✅ localDB initialized successfully');

    return this.#db;
  }

  async #initSyncEngine() {
    const { setOffline } = useOnlineStatus();

    this.#syncEngine = await this.#db.electric.syncShapeToTable({
      shape: {
        url: `https://buckitup.xyz/electric/v1/user_cards`,   // ← новий endpoint
        params: { table: "user_cards_synced" },
      },
      table: "user_cards_synced",
      primaryKey: ["user_hash"],
      shapeKey: "user_cards",
      onError: (error) => {
        console.error("Shape sync error:", error);
        setOffline();
      },
    });

    this.#syncEngine.stream.subscribe(() => {
      if (this.isLocalStash) {
        setTimeout(() => this.sendPendingChanges(), 800);
      }
    });
  }

  // ====================== Основні методи ======================

  async getUsers() {
    await this.init();
    const { rows } = await this.#db.query(`SELECT * FROM user_cards ORDER BY name`);
    return rows;
  }

  async getUser(userHash) {
    await this.init();
    const { rows } = await this.#db.query(
      `SELECT * FROM user_cards WHERE user_hash = $1`,
      [userHash]
    );
    return rows[0] || null;
  }

  async getPendingChanges() {
    await this.init();
    const { rows } = await this.#db.query(`SELECT * FROM user_cards_local`);
    return rows;
  }

  // ====================== Локальні зміни ======================

  async upsertUserLocal(userData) {
    await this.init();

    const {
      user_hash,
      sign_pkey,
      crypt_pkey,
      crypt_cert,
      contact_pkey,
      contact_cert,
      name,
    } = userData;

    await this.#db.query(
      `
      INSERT INTO user_cards_local (
        user_hash, sign_pkey, crypt_pkey, crypt_cert,
        contact_pkey, contact_cert, name, operation
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'update')
      ON CONFLICT (user_hash) DO UPDATE SET
        sign_pkey     = EXCLUDED.sign_pkey,
        crypt_pkey    = EXCLUDED.crypt_pkey,
        crypt_cert    = EXCLUDED.crypt_cert,
        contact_pkey  = EXCLUDED.contact_pkey,
        contact_cert  = EXCLUDED.contact_cert,
        name          = EXCLUDED.name,
        operation     = 'update',
        changed_at    = NOW()
      `,
      [user_hash, sign_pkey, crypt_pkey, crypt_cert, contact_pkey, contact_cert, name || '']
    );

    this.isLocalStash = true;
    this.sendPendingChanges();
  }

  async markUserAsDeleted(userHash) {
    await this.init();
    await this.#db.query(
      `INSERT INTO user_cards_local (user_hash, operation) VALUES ($1, 'delete')
       ON CONFLICT (user_hash) DO UPDATE SET operation = 'delete', changed_at = NOW()`,
      [userHash]
    );

    this.isLocalStash = true;
    this.sendPendingChanges();
  }

  async sendPendingChanges() {
    if (!navigator.onLine || !this.isLocalStash) return;

    const changes = await this.getPendingChanges();
    if (changes.length === 0) {
      this.isLocalStash = false;
      return;
    }

    const payloads = changes.map(row => ({
      type: row.operation === 'delete' ? 'delete' : 'upsert',
      [row.operation === 'delete' ? 'key' : 'modified']:
        row.operation === 'delete'
          ? { user_hash: row.user_hash }
          : row,
      syncMetadata: { relation: "user_cards" }
    }));

    try {
      await api.ingest(payloads);
      console.log(`Sent ${payloads.length} pending changes`);
    } catch (err) {
      console.warn("Failed to send pending changes, will retry later", err);
    }
  }

  // ====================== User Storage (версіонований) ======================

  async saveUserStorage(userHash, uuid, valueB64, version = null) {
    await this.init();
    const newVersion = version !== null ? version : Date.now();

    await this.#db.query(
      `INSERT INTO user_storage (user_hash, uuid, version, value_b64)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_hash, uuid, version) DO NOTHING`,
      [userHash, uuid, newVersion, valueB64]
    );
  }

  async getLatestUserStorage(userHash, uuid) {
    await this.init();
    const { rows } = await this.#db.query(
      `SELECT * FROM user_storage_latest 
       WHERE user_hash = $1 AND uuid = $2`,
      [userHash, uuid]
    );
    return rows[0] || null;
  }

  get instance() {
    return this.#db;
  }
}

export const localDB = new LocalDB();