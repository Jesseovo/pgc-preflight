CREATE TABLE IF NOT EXISTS settings_v2 (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR REPLACE INTO settings_v2 (id, value, updated_at)
  SELECT id, value, updated_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_v2 RENAME TO settings;