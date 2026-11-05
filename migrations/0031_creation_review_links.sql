-- An optional immutable game version on a device review, independent of model material.
ALTER TABLE review_jobs ADD COLUMN artifact_version_id TEXT;
CREATE INDEX review_jobs_artifact_version ON review_jobs(owner_id,artifact_version_id) WHERE artifact_version_id IS NOT NULL;
CREATE TRIGGER review_jobs_artifact_immutable BEFORE UPDATE OF artifact_version_id,input_hash,owner_id,topic_id ON review_jobs
WHEN OLD.artifact_version_id IS NOT NULL AND (NEW.artifact_version_id IS NOT OLD.artifact_version_id
  OR NEW.input_hash IS NOT OLD.input_hash OR NEW.owner_id IS NOT OLD.owner_id OR NEW.topic_id IS NOT OLD.topic_id)
BEGIN SELECT RAISE(ABORT,'review artifact version is immutable'); END;

-- These identifiers and hash are the member's submission record. The separate
-- creator_feedback_links row is the revocable source-verified association.
CREATE TABLE creation_review_submissions (
  task_id TEXT PRIMARY KEY REFERENCES review_jobs(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  known_work_id TEXT NOT NULL,
  known_submission_id TEXT NOT NULL,
  upload_hash TEXT NOT NULL CHECK(length(upload_hash)=64),
  provenance TEXT NOT NULL CHECK(provenance='creator-submission-record'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER creation_review_submissions_immutable BEFORE UPDATE ON creation_review_submissions
BEGIN SELECT RAISE(ABORT,'creation submission declaration is immutable'); END;

-- The older, independent human-review protocol may still write an exact matching
-- record. It cannot bind the job to a different submission, even concurrently.
CREATE TRIGGER creation_review_human_version_guard BEFORE INSERT ON review_human_reviews
WHEN NEW.work_id IS NOT NULL AND EXISTS(SELECT 1 FROM creation_review_submissions s WHERE s.task_id=NEW.job_id
  AND (s.known_work_id<>NEW.work_id OR s.known_submission_id<>NEW.version_id))
BEGIN SELECT RAISE(IGNORE); END;
