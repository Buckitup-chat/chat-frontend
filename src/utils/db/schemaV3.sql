-- ==========================================
-- Schema V3 for PQ Chat (Post-Quantum)
-- Optimized for localDBv2 and Shape Sync
-- ==========================================

-- 1. User Cards (Synchronized from network)
CREATE TABLE IF NOT EXISTS user_cards_synced (
    user_hash      TEXT PRIMARY KEY,         
    sign_pkey      TEXT,                      
    crypt_pkey     TEXT,                      
    crypt_cert     TEXT,                      
    contact_pkey   TEXT,                      
    contact_cert   TEXT,                      
    name           TEXT NOT NULL DEFAULT '',  
    updated_at     TIMESTAMPTZ DEFAULT NOW(),
    synced         BOOLEAN DEFAULT TRUE
);

-- 2. User Cards (Local changes, waiting for sync)
CREATE TABLE IF NOT EXISTS user_cards_local (
    user_hash      TEXT PRIMARY KEY,
    sign_pkey      TEXT,
    crypt_pkey     TEXT,
    crypt_cert     TEXT,
    contact_pkey   TEXT,
    contact_cert   TEXT,
    name           TEXT,
    operation      TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
    changed_at     TIMESTAMPTZ DEFAULT NOW(),
    synced         BOOLEAN DEFAULT FALSE
);

-- 3. Consolidated View for User Cards
CREATE OR REPLACE VIEW user_cards AS
SELECT 
    COALESCE(l.user_hash, s.user_hash)                  AS user_hash,
    COALESCE(l.sign_pkey,     s.sign_pkey)              AS sign_pkey,
    COALESCE(l.crypt_pkey,    s.crypt_pkey)             AS crypt_pkey,
    COALESCE(l.crypt_cert,    s.crypt_cert)             AS crypt_cert,
    COALESCE(l.contact_pkey,  s.contact_pkey)           AS contact_pkey,
    COALESCE(l.contact_cert,  s.contact_cert)           AS contact_cert,
    COALESCE(l.name,          s.name, '')               AS name,
    CASE 
        WHEN l.operation = 'delete' THEN FALSE
        ELSE COALESCE(l.synced, s.synced, FALSE)
    END AS synced,
    GREATEST(
        COALESCE(l.changed_at,  '1970-01-01'::timestamptz),
        COALESCE(s.updated_at,  '1970-01-01'::timestamptz)
    ) AS last_modified
FROM user_cards_synced s
FULL OUTER JOIN user_cards_local l ON s.user_hash = l.user_hash
WHERE l.operation IS NULL OR l.operation != 'delete';

-- 4. User Storage (Synchronized from network)
CREATE TABLE IF NOT EXISTS user_storage_synced (
    user_hash     TEXT NOT NULL,
    uuid          TEXT NOT NULL,               
    version       BIGINT NOT NULL DEFAULT 0,   
    value_b64     TEXT NOT NULL,               
    hash_b64      TEXT,                        
    deleted_flag  BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_hash, uuid, version)
);

-- 5. User Storage (Local changes)
CREATE TABLE IF NOT EXISTS user_storage_local (
    user_hash     TEXT NOT NULL,
    uuid          TEXT NOT NULL,
    version       BIGINT NOT NULL DEFAULT 0,
    value_b64     TEXT,
    hash_b64      TEXT,
    operation     TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'upsert')),
    changed_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_hash, uuid)
);

-- 6. Consolidated View for Latest User Storage
CREATE OR REPLACE VIEW user_storage_latest AS
SELECT DISTINCT ON (user_hash, uuid)
    COALESCE(l.user_hash, s.user_hash) as user_hash,
    COALESCE(l.uuid, s.uuid) as uuid,
    COALESCE(l.version, s.version) as version,
    COALESCE(l.value_b64, s.value_b64) as value_b64,
    COALESCE(l.hash_b64, s.hash_b64) as hash_b64,
    COALESCE(s.updated_at, l.changed_at) as updated_at
FROM user_storage_synced s
FULL OUTER JOIN user_storage_local l ON s.user_hash = l.user_hash AND s.uuid = l.uuid
WHERE (l.operation IS NULL OR l.operation != 'delete') 
  AND (s.deleted_flag IS NULL OR s.deleted_flag = FALSE)
ORDER BY user_hash, uuid, version DESC;

-- 7. Triggers for auto-cleanup
CREATE OR REPLACE FUNCTION cleanup_local_user_cards_after_sync()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM user_cards_local WHERE user_hash = NEW.user_hash;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_cleanup_local_user_cards
AFTER INSERT OR UPDATE ON user_cards_synced
FOR EACH ROW EXECUTE FUNCTION cleanup_local_user_cards_after_sync();

CREATE OR REPLACE FUNCTION cleanup_local_storage_after_sync()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM user_storage_local WHERE user_hash = NEW.user_hash AND uuid = NEW.uuid AND version <= NEW.version;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_cleanup_local_storage
AFTER INSERT OR UPDATE ON user_storage_synced
FOR EACH ROW EXECUTE FUNCTION cleanup_local_storage_after_sync();
