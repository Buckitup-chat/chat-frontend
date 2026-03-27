import { PGliteWorker } from "@electric-sql/pglite/worker";
import { electricSync } from "@electric-sql/pglite-sync";
import { live } from "@electric-sql/pglite/live";
import schemaSQL from "./schemaV2.sql?raw";
import { api } from "../../api/client";
import { useOnlineStatus } from "../../composables/useOnlineStatus";

class LocalDBv2 {
  constructor() {
    this.isOnline = navigator.onLine;
    this.isLocalStash = false;
    this.db = null;
    this.syncEngine = null;
  }

  get instance() {
    return this.db;
  }

  async init() {
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

      await this.initSyncEngine();

      const pending = await this.getPendingChanges();

      this.isLocalStash = pending.length > 0;

      this.syncEngine.stream.subscribe(() => {
        console.debug("user_cards_synced shape updated");

        if (this.isLocalStash) {
          setTimeout(() => this.sendPendingChanges(), 1200);
        }
      });

      console.log("→ DB initialized");
    } catch (err) {
      console.error("DB init failed:", err);
    }

    return this.db;
  }

  async initSyncEngine() {
    const { setOffline } = useOnlineStatus();

    this.syncEngine = await this.db.electric.syncShapeToTable({
      shape: {
        url: new URL(`/api/user_card`, window.location.origin).toString(),
        params: {
          table: "user",
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
    } = userData;

    await this.db.query(
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
      [user_hash, sign_pkey, crypt_pkey, crypt_cert, contact_pkey, contact_cert, name || ""]
    );

    this.isLocalStash = true;
    await this.sendPendingChanges();
  }

  async markUserAsDeletedLocal(userHash) {
    await this.db.query(
      `
      INSERT INTO user_cards_local (user_hash, operation)
      VALUES ($1, 'delete')
      ON CONFLICT (user_hash) DO UPDATE SET
        operation  = 'delete',
        changed_at = NOW()
      `,
      [userHash]
    );

    this.isLocalStash = true;

    await this.sendPendingChanges();
  }

  async sendPendingChanges() {
    if (!navigator.onLine || !this.isLocalStash) return;

    const changes = await this.getPendingChanges();
    if (changes.length === 0) {
      this.isLocalStash = false;

      return;
    }

    const payloads = changes.map((row) => {
      if (row.operation === "delete") {
        return {
          type: "delete",
          key: { user_hash: row.user_hash },
          syncMetadata: { relation: "user_cards" },
        };
      }

      return {
        type: row.operation === "insert" ? "insert" : "update",
        modified: {
          user_hash: row.user_hash,
          sign_pkey: row.sign_pkey,
          crypt_pkey: row.crypt_pkey,
          crypt_cert: row.crypt_cert,
          contact_pkey: row.contact_pkey,
          contact_cert: row.contact_cert,
          name: row.name,
        },
        syncMetadata: { relation: "user_cards" },
      };
    });

    try {
      await api.ingest(payloads);

      console.log(`→ Sent ${payloads.length} local user changes`);
    } catch (err) {
      console.warn("→ Sync of local users failed, will retry later", err);
    }
  }

  async debugLocalState() {
    const users = await this.getUsers();

    const pending = await this.getPendingChanges();

    console.table({ syncedAndLocalView: users, pendingChanges: pending });
  }
}

export const localDB = new LocalDBv2();