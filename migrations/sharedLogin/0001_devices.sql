-- Each account has its own enrollment token. Devices get independently revocable sessions.
CREATE TABLE shared_login_users (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE shared_login_devices (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES shared_login_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX shared_login_devices_user ON shared_login_devices(user_id, expires_at);
