CREATE TABLE IF NOT EXISTS review_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT NOT NULL DEFAULT '',
  result_id INTEGER,
  lease TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_jobs_owner ON review_jobs (owner_id, created_at);
ALTER TABLE reviews ADD COLUMN job_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_job ON reviews (job_id);
-- Small chunks keep temporary model inputs below D1's row/value size limit.
CREATE TABLE IF NOT EXISTS review_inputs (
  job_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, part)
);
