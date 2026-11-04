-- Additive telemetry only. Historical timestamps remain unknown.
-- The optional declared effort is atomically locked with the member draft.
ALTER TABLE review_jobs ADD COLUMN local_model_configuration TEXT;
CREATE TABLE IF NOT EXISTS review_execution_timing (
 job_id TEXT PRIMARY KEY REFERENCES review_jobs(id) ON DELETE CASCADE,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 outcome TEXT CHECK(outcome IN ('done','error')),
 model_name TEXT,
 effort TEXT,
 config_hash TEXT,
 config_origin TEXT CHECK(config_origin IN ('server','member-device')),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_execution_timing_started ON review_execution_timing(started_at,job_id);
CREATE TABLE IF NOT EXISTS review_timing_events (
 job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 phase TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('server','member-device')),
 started_at TEXT NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms>=0 AND duration_ms<=86400000),
 status TEXT NOT NULL CHECK(status IN ('ok','error')),
 received_at TEXT NOT NULL,
 PRIMARY KEY(job_id,event_id)
);
CREATE INDEX IF NOT EXISTS review_timing_events_received ON review_timing_events(received_at);
CREATE TABLE IF NOT EXISTS review_timing_boundaries (
 job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('material_ready','draft_received','verification_ready','completed')),
 occurred_at TEXT NOT NULL,
 PRIMARY KEY(job_id,phase)
);
ALTER TABLE model_runs ADD COLUMN capacity_wait_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN throttle_wait_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN retry_wait_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN request_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN first_response_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN first_text_from_request_ms INTEGER;
ALTER TABLE model_runs ADD COLUMN first_text_kind TEXT;
ALTER TABLE model_runs ADD COLUMN attempts INTEGER;
