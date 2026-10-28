-- Administrator reads remain metadata-only and paginate in SQLite.
CREATE INDEX topics_admin_updated ON topics(updated_at DESC,id DESC);
CREATE INDEX topics_admin_owner_updated ON topics(owner_id,updated_at DESC,id DESC);
CREATE INDEX games_admin_updated ON games(updated_at DESC,id DESC);
CREATE INDEX games_admin_owner_updated ON games(owner_id,updated_at DESC,id DESC);
CREATE INDEX forge_tasks_admin_created ON forge_tasks(created_at DESC,id DESC);
CREATE INDEX forge_tasks_admin_owner_created ON forge_tasks(owner_id,created_at DESC,id DESC);
CREATE INDEX forge_tasks_admin_owner_updated ON forge_tasks(owner_id,updated_at DESC,status);
CREATE INDEX forge_tasks_admin_topic ON forge_tasks(owner_id,(CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload,'$.id'),json_extract(payload,'$.ids[0]')) END),executor,status);
CREATE INDEX review_jobs_admin_created ON review_jobs(created_at DESC,id DESC);
CREATE INDEX review_jobs_admin_owner_updated ON review_jobs(owner_id,updated_at DESC,status);
CREATE INDEX artifact_versions_first_product ON artifact_versions(kind,topic_id,created_at);
CREATE INDEX artifact_versions_admin_topic ON artifact_versions(topic_id,owner_id,kind,created_at DESC);
CREATE INDEX reviews_admin_topic ON reviews(topic_id,owner_id,created_at DESC);

-- Persist the explicitly supplied topic relation before temporary inputs expire.
-- Historical relations come only from the original job/report relationship.
ALTER TABLE review_jobs ADD COLUMN topic_id INTEGER;
UPDATE review_jobs SET topic_id=(SELECT r.topic_id FROM reviews r WHERE r.job_id=review_jobs.id AND r.owner_id=review_jobs.owner_id AND r.topic_id IS NOT NULL)
 WHERE EXISTS(SELECT 1 FROM reviews r WHERE r.job_id=review_jobs.id AND r.owner_id=review_jobs.owner_id AND r.topic_id IS NOT NULL);
CREATE INDEX review_jobs_admin_topic ON review_jobs(topic_id,owner_id,created_at DESC);

-- A failed task can have one direct retry. The original task stays immutable.
ALTER TABLE forge_tasks ADD COLUMN retry_of TEXT REFERENCES forge_tasks(id);
ALTER TABLE forge_tasks ADD COLUMN requested_by TEXT;
CREATE UNIQUE INDEX forge_tasks_one_direct_retry ON forge_tasks(retry_of) WHERE retry_of IS NOT NULL;
