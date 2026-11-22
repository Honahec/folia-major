CREATE TABLE sync_ai_settings (
    user_id TEXT PRIMARY KEY REFERENCES shared_login_users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    sealed_profile TEXT NOT NULL
);
