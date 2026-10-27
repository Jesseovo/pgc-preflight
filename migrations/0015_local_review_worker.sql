ALTER TABLE review_jobs ADD COLUMN executor TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE review_jobs ADD COLUMN input_ready INTEGER NOT NULL DEFAULT 1;
ALTER TABLE review_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE review_jobs ADD COLUMN model_snapshot TEXT;
ALTER TABLE review_jobs ADD COLUMN evidence_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_jobs ADD COLUMN evidence_hash TEXT;
ALTER TABLE review_jobs ADD COLUMN model_execution_started_at TEXT;
CREATE INDEX IF NOT EXISTS review_jobs_claim ON review_jobs(executor,status,input_ready,created_at);
CREATE INDEX IF NOT EXISTS review_jobs_worker ON review_jobs(worker_id,status);
CREATE TABLE review_pairings (
  code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_version TEXT NOT NULL,
  expires_at TEXT NOT NULL, device_id TEXT
);
CREATE TABLE review_devices (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_version TEXT NOT NULL,
  token_hash TEXT NOT NULL, pairing_hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL,
  last_seen TEXT, free_memory_mb INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX review_devices_owner ON review_devices(owner_id,revoked);
CREATE UNIQUE INDEX review_devices_token ON review_devices(token_hash);
CREATE TABLE review_evidence (
  job_id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,part)
);
