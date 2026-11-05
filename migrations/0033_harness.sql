ALTER TABLE forge_tasks ADD COLUMN harness_policy TEXT;
ALTER TABLE review_jobs ADD COLUMN harness_policy TEXT;

CREATE TABLE harness_runs (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK(family IN ('forge','review')),
  actor TEXT NOT NULL CHECK(actor IN ('star','admin')),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  profile_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  purpose TEXT NOT NULL CHECK(purpose IN ('review','review_verify','create','expand','brief','assets','preview','game','tags','vocab')),
  protocol TEXT NOT NULL CHECK(protocol IN ('anthropic','openai')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL CHECK(effort IN ('auto','low','medium','high','xhigh','max')),
  vision INTEGER NOT NULL CHECK(vision IN (0,1)),
  per_request_cap INTEGER NOT NULL CHECK(per_request_cap BETWEEN 1 AND 64000),
  total_output_cap INTEGER NOT NULL CHECK(total_output_cap BETWEEN 1 AND 256000),
  max_model_turns INTEGER NOT NULL CHECK(max_model_turns BETWEEN 1 AND 24),
  max_repairs INTEGER NOT NULL CHECK(max_repairs BETWEEN 0 AND 2),
  lease_hash TEXT NOT NULL CHECK(length(lease_hash)=64),
  slot INTEGER NOT NULL CHECK(slot IN (1,2)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','failed','unknown')),
  failure_code TEXT,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK(deadline_at>started_at AND deadline_at<=started_at+2400000),
  ended_at INTEGER,
  released_at INTEGER,
  model_turns INTEGER NOT NULL DEFAULT 0 CHECK(model_turns BETWEEN 0 AND max_model_turns),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),
  CHECK(output_tokens + reserved_tokens<=total_output_cap),
  CHECK((status='active')=(ended_at IS NULL)),
  CHECK(released_at IS NULL OR ended_at IS NOT NULL),
  CHECK((actor='admin')=(owner_id='admin')),
  CHECK((family='review')=(purpose IN ('review','review_verify'))),
  CHECK(purpose='game' OR max_repairs=0),
  PRIMARY KEY(task_id,generation),
  UNIQUE(task_id)
);
CREATE UNIQUE INDEX harness_live_slots ON harness_runs(slot) WHERE released_at IS NULL;
CREATE INDEX harness_owner_runs ON harness_runs(owner_id,started_at DESC);

CREATE TABLE harness_requests (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  output_cap INTEGER NOT NULL CHECK(output_cap BETWEEN 1 AND 64000),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','forwarded','completed','failed','unknown')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK(deadline_at>created_at AND deadline_at<=created_at+720000),
  forwarded_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
  finished_at INTEGER,
  http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
  input_tokens INTEGER CHECK(input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND output_cap),
  reasoning_tokens INTEGER CHECK(reasoning_tokens BETWEEN 0 AND output_tokens),
  characters INTEGER CHECK(characters BETWEEN 0 AND 12582912),
  first_response_ms INTEGER CHECK(first_response_ms>=0),
  error_code TEXT,
  finish_reason TEXT,
  CHECK((state IN ('completed','failed','unknown'))=(finished_at IS NOT NULL)),
  CHECK(state NOT IN ('forwarded','completed','unknown') OR forwarded_at IS NOT NULL),
  CHECK(state!='completed' OR (output_tokens IS NOT NULL AND error_code IS NULL)),
  PRIMARY KEY(task_id,generation,request_id),
  FOREIGN KEY(task_id,generation) REFERENCES harness_runs(task_id,generation) ON DELETE CASCADE
);
CREATE UNIQUE INDEX harness_one_live_model_call ON harness_requests(task_id,generation) WHERE state IN ('reserved','forwarded');
CREATE INDEX harness_request_recovery ON harness_requests(deadline_at) WHERE state IN ('reserved','forwarded');

CREATE TABLE harness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('started','booted','browser','repair','artifact','cleanup')),
  value INTEGER CHECK(value BETWEEN 0 AND 2400000),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(task_id,generation) REFERENCES harness_runs(task_id,generation) ON DELETE CASCADE
);
CREATE INDEX harness_run_events ON harness_events(task_id,generation,id);

-- The trigger and request insertion share one SQLite statement/transaction.
CREATE TRIGGER harness_debit_reservation AFTER INSERT ON harness_requests
BEGIN
  UPDATE harness_runs SET model_turns=model_turns+1,reserved_tokens=reserved_tokens+NEW.output_cap
  WHERE task_id=NEW.task_id AND generation=NEW.generation;
END;

-- Unknown outcomes retain the reservation and latch the whole run.
CREATE TRIGGER harness_finalize_reservation AFTER UPDATE OF state ON harness_requests
WHEN OLD.state IN ('reserved','forwarded') AND NEW.state IN ('completed','failed','unknown')
BEGIN
  UPDATE harness_runs SET
    reserved_tokens=reserved_tokens-CASE WHEN NEW.state='unknown' THEN 0 ELSE NEW.output_cap END,
    output_tokens=output_tokens+CASE WHEN NEW.state='unknown' THEN 0 ELSE coalesce(NEW.output_tokens,0) END,
    status=CASE WHEN status='active' AND NEW.state!='completed' THEN NEW.state ELSE status END,
    failure_code=CASE WHEN status='active' AND NEW.state!='completed' THEN NEW.error_code ELSE failure_code END,
    ended_at=CASE WHEN status='active' AND NEW.state!='completed' THEN NEW.finished_at ELSE ended_at END
  WHERE task_id=NEW.task_id AND generation=NEW.generation;
END;

CREATE TRIGGER harness_debit_retry AFTER UPDATE OF state ON harness_requests
WHEN OLD.state='reserved' AND NEW.state='forwarded' AND OLD.attempts>0
BEGIN
  UPDATE harness_runs SET model_turns=model_turns+1
  WHERE task_id=NEW.task_id AND generation=NEW.generation;
END;

-- Keep admin model telemetry usable without blending the two execution paths.
CREATE TRIGGER harness_model_telemetry AFTER UPDATE OF state ON harness_requests
WHEN OLD.state IN ('reserved','forwarded') AND NEW.state IN ('completed','failed','unknown') AND NEW.attempts>0
BEGIN
  INSERT INTO model_runs(id,profile_id,model,purpose,status,effort,max_tokens,input_tokens,output_tokens,
    reasoning_tokens,elapsed_ms,characters,finish_reason,error,created_at,first_response_ms,attempts)
  SELECT 'harness:'||NEW.task_id||':'||NEW.generation||':'||NEW.request_id,profile_id,model,'harness:'||purpose,
    CASE WHEN NEW.state='completed' THEN 'ok' ELSE 'error' END,effort,NEW.output_cap,NEW.input_tokens,NEW.output_tokens,
    NEW.reasoning_tokens,max(0,NEW.finished_at-NEW.created_at),coalesce(NEW.characters,0),coalesce(NEW.finish_reason,''),coalesce(NEW.error_code,''),
    strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at/1000.0,'unixepoch'),NEW.first_response_ms,NEW.attempts
  FROM harness_runs WHERE task_id=NEW.task_id AND generation=NEW.generation;
END;
