-- The Worker keeps the provider session and owns the pending QR attempt.
CREATE TABLE shared_provider_sessions (
    user_id TEXT NOT NULL REFERENCES shared_login_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    sealed_token TEXT,
    refresh_after INTEGER NOT NULL DEFAULT 0,
    refresh_until INTEGER NOT NULL DEFAULT 0,
    qr_id TEXT,
    qr_device_id TEXT,
    qr_key TEXT,
    PRIMARY KEY (user_id, provider)
);

CREATE INDEX shared_provider_sessions_due ON shared_provider_sessions(provider, refresh_after)
    WHERE sealed_token IS NOT NULL;
