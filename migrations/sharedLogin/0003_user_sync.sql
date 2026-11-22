-- Store sync data beside each user's existing music authorizations.
CREATE TABLE sync_settings (
    user_id TEXT PRIMARY KEY REFERENCES shared_login_users(id) ON DELETE CASCADE,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE sync_themes (
    user_id TEXT NOT NULL REFERENCES shared_login_users(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    bucket_id INTEGER NOT NULL,
    theme_json TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    digest INTEGER NOT NULL,
    PRIMARY KEY (user_id, fingerprint)
);

CREATE INDEX sync_themes_by_bucket ON sync_themes (user_id, bucket_id, fingerprint);

CREATE TABLE sync_theme_buckets (
    user_id TEXT NOT NULL REFERENCES shared_login_users(id) ON DELETE CASCADE,
    bucket_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    digest INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, bucket_id)
);

-- Update the manifest in the same transaction as each theme, including concurrent uploads.
CREATE TRIGGER sync_themes_insert AFTER INSERT ON sync_themes
BEGIN
    INSERT INTO sync_theme_buckets (user_id, bucket_id, count, digest, updated_at)
    VALUES (NEW.user_id, NEW.bucket_id, 1, NEW.digest, NEW.updated_at)
    ON CONFLICT (user_id, bucket_id) DO UPDATE SET
        count = count + 1,
        digest = (digest | excluded.digest) - (digest & excluded.digest),
        updated_at = MAX(updated_at, excluded.updated_at);
END;

CREATE TRIGGER sync_themes_update AFTER UPDATE ON sync_themes
BEGIN
    UPDATE sync_theme_buckets
    SET digest = ((digest | OLD.digest) - (digest & OLD.digest) | NEW.digest)
                 - ((digest | OLD.digest) - (digest & OLD.digest) & NEW.digest),
        updated_at = MAX(updated_at, NEW.updated_at)
    WHERE user_id = NEW.user_id AND bucket_id = NEW.bucket_id;
END;
