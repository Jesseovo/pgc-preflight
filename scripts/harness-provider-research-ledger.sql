-- Apply only to the isolated research D1 after the ordinary ledger schema.
CREATE TABLE provider_research_assistant_digests (
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  assistant_sha256 TEXT NOT NULL CHECK(length(assistant_sha256)=64 AND assistant_sha256 NOT GLOB '*[^a-f0-9]*'),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  PRIMARY KEY(task_id,generation,request_id),
  FOREIGN KEY(task_id,generation,request_id) REFERENCES harness_requests(task_id,generation,request_id) ON DELETE CASCADE
) STRICT;
