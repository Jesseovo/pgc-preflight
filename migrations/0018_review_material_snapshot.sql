ALTER TABLE review_jobs ADD COLUMN local_material_hash TEXT;
-- Store the locked prompt/calibration without duplicating the four image blobs.
CREATE TABLE review_material (
  job_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,part)
);
