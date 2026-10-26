-- Only a one-way credential digest and scheduling times; never the API key.
CREATE TABLE IF NOT EXISTS model_throttle (
  id TEXT PRIMARY KEY,
  next_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
