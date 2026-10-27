-- Approval is explicit; old human scores never imply a publication decision.
ALTER TABLE review_human_reviews ADD COLUMN decision TEXT CHECK(decision IN ('approved','rejected'));
CREATE INDEX review_human_reviews_version ON review_human_reviews(owner_id,work_id,version_id,source_updated_at DESC,id DESC);
CREATE TABLE gallery_games (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  part_count INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,work_id,version_id)
);
CREATE TABLE gallery_game_html (
  game_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(game_id,part)
);
CREATE TABLE gallery_publish_requests (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,request_id)
);
