-- Status polling and recovery must not scan all completed game history.
CREATE INDEX review_jobs_recovery ON review_jobs(model_executor,status,updated_at);
CREATE INDEX review_jobs_owner_status ON review_jobs(owner_id,status,created_at);
