-- Runtime metadata and private, immutable workspace revisions. No model
-- transcript, reasoning, provider credentials or member credentials belong here.
CREATE TABLE harness_embedded_phases (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  phase TEXT NOT NULL,
  core_version TEXT NOT NULL,
  material_hash TEXT NOT NULL CHECK(length(material_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
  current_tool TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  stop_reason TEXT,
  PRIMARY KEY(task_id,generation,phase),
  FOREIGN KEY(task_id,generation) REFERENCES harness_runs(task_id,generation) ON DELETE CASCADE
);
CREATE TABLE harness_embedded_artifacts (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  phase TEXT NOT NULL,
  path TEXT NOT NULL CHECK(path IN ('game.html','record.json','result.txt')),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  part INTEGER NOT NULL CHECK(part>=0),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id,generation,phase,path,content_hash,part),
  FOREIGN KEY(task_id,generation) REFERENCES harness_runs(task_id,generation) ON DELETE CASCADE
);
CREATE INDEX harness_embedded_artifact_expiry ON harness_embedded_artifacts(created_at);
CREATE TABLE harness_embedded_diagnostics (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('main','compact')),
  measurements TEXT NOT NULL CHECK(json_valid(measurements)),
  failure_code TEXT,
  PRIMARY KEY(task_id,generation,request_id),
  FOREIGN KEY(task_id,generation,request_id) REFERENCES harness_requests(task_id,generation,request_id) ON DELETE CASCADE
);
CREATE TABLE harness_embedded_tools (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  phase TEXT NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('running','completed','error','interrupted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY(task_id,generation,phase,call_id),
  FOREIGN KEY(task_id,generation) REFERENCES harness_runs(task_id,generation) ON DELETE CASCADE
);
