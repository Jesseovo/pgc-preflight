-- Hash only the uploaded HTML bytes; the original source remains temporary.
ALTER TABLE review_jobs ADD COLUMN input_hash TEXT;
CREATE TABLE review_human_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  work_id TEXT,
  version_id TEXT,
  score REAL,
  feedback TEXT,
  source_updated_at TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reviewed','pending','unavailable','unlinked')),
  phase TEXT CHECK(phase IN ('final','preliminary')),
  matched_by TEXT CHECK(matched_by IN ('user-confirmed','published-record')),
  uploaded_content_hash TEXT,
  display_rank INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(job_id,request_id),
  CHECK((work_id IS NULL) = (version_id IS NULL))
);
CREATE INDEX review_human_reviews_history ON review_human_reviews(job_id,id DESC);
CREATE UNIQUE INDEX review_human_reviews_current ON review_human_reviews(job_id) WHERE is_current=1;
