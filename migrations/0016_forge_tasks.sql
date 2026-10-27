CREATE TABLE forge_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  model_started_at TEXT
);
CREATE UNIQUE INDEX forge_tasks_active_scope ON forge_tasks(scope) WHERE status IN ('queued','running');
CREATE INDEX forge_tasks_status ON forge_tasks(status,updated_at);
