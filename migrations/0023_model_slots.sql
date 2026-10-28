CREATE TABLE model_slots (
 request_id TEXT PRIMARY KEY,
 key_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX model_slots_key_expiry ON model_slots(key_id,expires_at);
CREATE INDEX model_slots_expiry ON model_slots(expires_at);
