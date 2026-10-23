CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY CHECK (id = 'model'),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
