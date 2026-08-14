-- ==========================================
-- Schema V4 — Linearlite (single-table merge-on-write)
-- No _synced/_local split. Single table per entity.
-- modified_columns tracks unsynced local changes.
-- BEFORE INSERT trigger handles Electric sync merge.
-- ==========================================

-- ==========================================
-- DIALOG KEYS
-- ==========================================
CREATE TABLE IF NOT EXISTS dialog_keys (
    dialog_hash   TEXT,
    sender_hash   TEXT,
    peer_hash     TEXT,
    peer_kem_wrap_key_b64 TEXT,
    peer_wrapped_msg_key_b64 TEXT,
    owner_timestamp BIGINT,
    deleted_flag  BOOLEAN DEFAULT FALSE,
    sign_b64      TEXT,
    modified_columns TEXT[],
    sent_to_server BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (dialog_hash, sender_hash)
);

-- ==========================================
-- DIALOG MESSAGES
-- ==========================================
CREATE TABLE IF NOT EXISTS dialog_messages (
    message_id    TEXT PRIMARY KEY,
    dialog_hash   TEXT,
    sender_hash   TEXT,
    content_b64   TEXT,
    deleted_flag  BOOLEAN DEFAULT FALSE,
    refs_map_b64  TEXT,
    parent_sign_hash TEXT,
    owner_timestamp BIGINT,
    sign_b64      TEXT,
    sign_hash     TEXT,
    modified_columns TEXT[],
    sent_to_server BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- DIALOG MESSAGES VERSIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS dialog_messages_versions (
    message_id    TEXT,
    sign_hash     TEXT,
    dialog_hash   TEXT,
    sender_hash   TEXT,
    content_b64   TEXT,
    deleted_flag  BOOLEAN DEFAULT FALSE,
    refs_map_b64  TEXT,
    parent_sign_hash TEXT,
    owner_timestamp BIGINT,
    sign_b64      TEXT,
    modified_columns TEXT[],
    sent_to_server BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (message_id, sign_hash)
);

-- ==========================================
-- DIALOG MESSAGE REACTIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS dialog_message_reactions (
    reaction_hash TEXT PRIMARY KEY,
    dialog_hash   TEXT,
    message_id    TEXT,
    message_sign_hash TEXT,
    reactor_hash  TEXT,
    type_b64      TEXT,
    deleted_flag  BOOLEAN DEFAULT FALSE,
    owner_timestamp BIGINT,
    sign_b64      TEXT,
    modified_columns TEXT[],
    sent_to_server BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- DIALOG MESSAGE RECEIPTS
-- ==========================================
CREATE TABLE IF NOT EXISTS dialog_message_receipts (
    receipt_hash  TEXT PRIMARY KEY,
    dialog_hash   TEXT,
    message_id    TEXT,
    peer_hash     TEXT,
    type          TEXT,
    message_sign_hash TEXT,
    owner_timestamp BIGINT,
    sign_b64      TEXT,
    modified_columns TEXT[],
    sent_to_server BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- BEFORE INSERT merge triggers (Electric sync)
-- Each trigger: if row exists with local modifications
-- (modified_columns IS NOT NULL), skip incoming.
-- Otherwise, accept incoming (delete old, insert new).
-- ==========================================

-- Optimized: UPDATE existing row (1 query), skip INSERT.
-- If row has local changes (modified_columns IS NOT NULL) → skip.
-- If row doesn't exist → fall through to INSERT.
--
CREATE OR REPLACE FUNCTION merge_dialog_keys()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('electric.syncing', true) = 'true' THEN
        UPDATE dialog_keys SET
            peer_hash = NEW.peer_hash, peer_kem_wrap_key_b64 = NEW.peer_kem_wrap_key_b64,
            peer_wrapped_msg_key_b64 = NEW.peer_wrapped_msg_key_b64,
            owner_timestamp = NEW.owner_timestamp, deleted_flag = NEW.deleted_flag,
            sign_b64 = NEW.sign_b64, updated_at = NOW()
        WHERE dialog_hash = NEW.dialog_hash AND sender_hash = NEW.sender_hash AND modified_columns IS NULL;
        IF FOUND THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM dialog_keys WHERE dialog_hash = NEW.dialog_hash AND sender_hash = NEW.sender_hash) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merge_dialog_keys ON dialog_keys;
CREATE TRIGGER trg_merge_dialog_keys
BEFORE INSERT ON dialog_keys
FOR EACH ROW EXECUTE FUNCTION merge_dialog_keys();

CREATE OR REPLACE FUNCTION merge_dialog_messages()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('electric.syncing', true) = 'true' THEN
        UPDATE dialog_messages SET
            dialog_hash = NEW.dialog_hash, sender_hash = NEW.sender_hash,
            content_b64 = NEW.content_b64, deleted_flag = NEW.deleted_flag,
            refs_map_b64 = NEW.refs_map_b64, parent_sign_hash = NEW.parent_sign_hash,
            owner_timestamp = NEW.owner_timestamp, sign_b64 = NEW.sign_b64,
            sign_hash = NEW.sign_hash, updated_at = NOW()
        WHERE message_id = NEW.message_id AND modified_columns IS NULL;
        IF FOUND THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM dialog_messages WHERE message_id = NEW.message_id) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merge_dialog_messages ON dialog_messages;
CREATE TRIGGER trg_merge_dialog_messages
BEFORE INSERT ON dialog_messages
FOR EACH ROW EXECUTE FUNCTION merge_dialog_messages();

CREATE OR REPLACE FUNCTION merge_dialog_messages_versions()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('electric.syncing', true) = 'true' THEN
        UPDATE dialog_messages_versions SET
            dialog_hash = NEW.dialog_hash, sender_hash = NEW.sender_hash,
            content_b64 = NEW.content_b64, deleted_flag = NEW.deleted_flag,
            refs_map_b64 = NEW.refs_map_b64, parent_sign_hash = NEW.parent_sign_hash,
            owner_timestamp = NEW.owner_timestamp, sign_b64 = NEW.sign_b64,
            updated_at = NOW()
        WHERE message_id = NEW.message_id AND sign_hash = NEW.sign_hash AND modified_columns IS NULL;
        IF FOUND THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM dialog_messages_versions WHERE message_id = NEW.message_id AND sign_hash = NEW.sign_hash) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merge_dialog_messages_versions ON dialog_messages_versions;
CREATE TRIGGER trg_merge_dialog_messages_versions
BEFORE INSERT ON dialog_messages_versions
FOR EACH ROW EXECUTE FUNCTION merge_dialog_messages_versions();

CREATE OR REPLACE FUNCTION merge_dialog_message_reactions()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('electric.syncing', true) = 'true' THEN
        UPDATE dialog_message_reactions SET
            dialog_hash = NEW.dialog_hash, message_id = NEW.message_id,
            message_sign_hash = NEW.message_sign_hash, reactor_hash = NEW.reactor_hash,
            type_b64 = NEW.type_b64, deleted_flag = NEW.deleted_flag,
            owner_timestamp = NEW.owner_timestamp, sign_b64 = NEW.sign_b64,
            updated_at = NOW()
        WHERE reaction_hash = NEW.reaction_hash AND modified_columns IS NULL;
        IF FOUND THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM dialog_message_reactions WHERE reaction_hash = NEW.reaction_hash) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merge_dialog_message_reactions ON dialog_message_reactions;
CREATE TRIGGER trg_merge_dialog_message_reactions
BEFORE INSERT ON dialog_message_reactions
FOR EACH ROW EXECUTE FUNCTION merge_dialog_message_reactions();

CREATE OR REPLACE FUNCTION merge_dialog_message_receipts()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('electric.syncing', true) = 'true' THEN
        UPDATE dialog_message_receipts SET
            dialog_hash = NEW.dialog_hash, message_id = NEW.message_id,
            peer_hash = NEW.peer_hash, type = NEW.type,
            message_sign_hash = NEW.message_sign_hash, owner_timestamp = NEW.owner_timestamp,
            sign_b64 = NEW.sign_b64, updated_at = NOW()
        WHERE receipt_hash = NEW.receipt_hash AND modified_columns IS NULL;
        IF FOUND THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM dialog_message_receipts WHERE receipt_hash = NEW.receipt_hash) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merge_dialog_message_receipts ON dialog_message_receipts;
CREATE TRIGGER trg_merge_dialog_message_receipts
BEFORE INSERT ON dialog_message_receipts
FOR EACH ROW EXECUTE FUNCTION merge_dialog_message_receipts();
