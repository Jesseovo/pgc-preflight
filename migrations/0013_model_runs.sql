CREATE TABLE IF NOT EXISTS model_runs (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, model TEXT NOT NULL,
 purpose TEXT NOT NULL, status TEXT NOT NULL, effort TEXT NOT NULL, max_tokens INTEGER NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
 first_text_ms INTEGER, elapsed_ms INTEGER NOT NULL, characters INTEGER NOT NULL,
 finish_reason TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_runs_created ON model_runs(created_at DESC);
