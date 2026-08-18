-- ============================================================================
--  DIGITAL ASSET MANAGEMENT PLATFORM — COMPLETE DATABASE SCHEMA
--  Target: PostgreSQL 14+
--
--  This is the full v1 schema. The actual files live in S3-compatible object
--  storage; this database holds only metadata so it can be searched and
--  organised. Run this file once against an empty database to create
--  everything.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fast fuzzy / partial text matching


-- ============================================================================
--  1. LOOKUP: RESOURCE TYPES  (image, video, document, audio)
-- ============================================================================
CREATE TABLE resource_types (
    id    serial PRIMARY KEY,
    name  text NOT NULL UNIQUE
);


-- ============================================================================
--  2. USER GROUPS  (permissions live on the group, not the individual user)
--     Roles map onto these flags:
--       viewer  -> can_download
--       editor  -> can_download + can_upload
--       admin   -> can_admin (full system control)
-- ============================================================================
CREATE TABLE user_groups (
    id            serial PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    can_download  boolean NOT NULL DEFAULT true,
    can_upload    boolean NOT NULL DEFAULT false,
    can_admin     boolean NOT NULL DEFAULT false
);


-- ============================================================================
--  3. USERS
-- ============================================================================
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           text NOT NULL UNIQUE,
    password_hash   text NOT NULL,               -- hashed, never plain text
    full_name       text,
    group_id        integer REFERENCES user_groups(id),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'disabled')),
    email_verified  boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_group ON users(group_id);


-- ============================================================================
--  4. EMAIL TOKENS  (email verification + password reset)
--     Store a HASH of the token, not the token itself. Tokens are single-use
--     (used_at) and time-limited (expires_at).
-- ============================================================================
CREATE TABLE email_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);


-- ============================================================================
--  5. RESOURCES  (one row per uploaded file; bytes live in storage_key)
-- ============================================================================
CREATE TABLE resources (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type_id   integer REFERENCES resource_types(id),

    -- identity / storage
    title              text,
    original_filename  text NOT NULL,
    storage_key        text NOT NULL UNIQUE,      -- address in object storage
    checksum_sha256    text,                       -- integrity + dedupe

    -- file facts
    mime_type          text NOT NULL,
    size_bytes         bigint NOT NULL,
    status             text NOT NULL DEFAULT 'uploading'
                       CHECK (status IN ('uploading','processing','ready','failed')),

    -- media specifics (NULL when not applicable)
    width              int,
    height             int,
    duration_seconds   numeric(10,2),

    -- searchable text
    description        text,
    extracted_text     text,    -- PDF text / OCR / transcript, filled by worker

    created_by         uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- Full-text search vector, maintained automatically by PostgreSQL.
    -- Weights: title (A) > filename (B) > description (C) > body text (D).
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')),             'A') ||
        setweight(to_tsvector('english', coalesce(original_filename, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(description, '')),       'C') ||
        setweight(to_tsvector('english', coalesce(extracted_text, '')),    'D')
    ) STORED
);

CREATE INDEX idx_resources_type     ON resources(resource_type_id);
CREATE INDEX idx_resources_status   ON resources(status);
CREATE INDEX idx_resources_mime     ON resources(mime_type);
CREATE INDEX idx_resources_creator  ON resources(created_by);
CREATE INDEX idx_resources_search   ON resources USING gin(search_vector);            -- full-text
CREATE INDEX idx_resources_filename ON resources USING gin(original_filename gin_trgm_ops); -- fuzzy


-- ============================================================================
--  6. RENDITIONS  (thumbnails / previews the worker generates)
-- ============================================================================
CREATE TABLE renditions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('thumbnail', 'preview')),
    storage_key  text NOT NULL UNIQUE,
    mime_type    text,
    width        int,
    height       int,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (resource_id, kind)
);

CREATE INDEX idx_renditions_resource ON renditions(resource_id);


-- ============================================================================
--  7. CONFIGURABLE METADATA FIELDS
--     The admin defines the fields; each resource provides values for them.
--     (Tags are handled as one of these fields, e.g. a field named 'Tags'.)
-- ============================================================================
CREATE TABLE metadata_fields (
    id          serial PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    field_type  text NOT NULL DEFAULT 'text',
    searchable  boolean NOT NULL DEFAULT true
);

CREATE TABLE resource_field_data (
    resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    field_id     integer NOT NULL REFERENCES metadata_fields(id) ON DELETE CASCADE,
    value        text,
    PRIMARY KEY (resource_id, field_id)
);

CREATE INDEX idx_field_data_field ON resource_field_data(field_id);
CREATE INDEX idx_field_data_value ON resource_field_data USING gin(value gin_trgm_ops);


-- ============================================================================
--  8. COLLECTIONS  (group resources together; e.g. one per client)
-- ============================================================================
CREATE TABLE collections (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    owner_id    uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_resource (
    collection_id  uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    resource_id    uuid NOT NULL REFERENCES resources(id)   ON DELETE CASCADE,
    PRIMARY KEY (collection_id, resource_id)
);

CREATE INDEX idx_collection_resource_resource ON collection_resource(resource_id);


-- ============================================================================
--  9. CLIENT ISOLATION  (which collections each group may access)
--     A client's group is granted only that client's collections.
-- ============================================================================
CREATE TABLE group_collection_access (
    group_id       integer NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    collection_id  uuid    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, collection_id)
);

CREATE INDEX idx_group_access_collection ON group_collection_access(collection_id);


-- ============================================================================
--  10. AUDIT LOG  (who did what — especially who downloaded which file)
-- ============================================================================
CREATE TABLE audit_log (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    action       text NOT NULL,    -- e.g. 'login','upload','download','permission_change'
    resource_id  uuid REFERENCES resources(id) ON DELETE SET NULL,
    detail       jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user     ON audit_log(user_id);
CREATE INDEX idx_audit_resource ON audit_log(resource_id);
CREATE INDEX idx_audit_created  ON audit_log(created_at);


-- ============================================================================
--  11. KEEP resources.updated_at FRESH
-- ============================================================================
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_resources_touch
    BEFORE UPDATE ON resources
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================================
--  EXAMPLE: full-text search, ranked, newest first on ties
-- ============================================================================
-- SELECT r.id, r.title, ts_rank(r.search_vector, q) AS rank
-- FROM   resources r, websearch_to_tsquery('english', 'annual report pdf') q
-- WHERE  r.search_vector @@ q
--   AND  r.status = 'ready'
-- ORDER  BY rank DESC, r.created_at DESC
-- LIMIT  50;


-- ============================================================================
--  FUTURE (v2) — SCOPED CLIENT-ADMIN MODEL
--  Only add this if you adopt the "Coperon superadmins, clients scoped
--  administrators" option. It tags every group, collection, and user with the
--  client it belongs to, so the system can check whether an action falls inside
--  a client administrator's own territory. Left commented out for v1.
-- ============================================================================
-- CREATE TABLE clients (
--     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     name        text NOT NULL UNIQUE,
--     created_at  timestamptz NOT NULL DEFAULT now()
-- );
--
-- ALTER TABLE user_groups ADD COLUMN client_id uuid REFERENCES clients(id);
-- ALTER TABLE collections ADD COLUMN client_id uuid REFERENCES clients(id);
-- ALTER TABLE users       ADD COLUMN client_id uuid REFERENCES clients(id);
