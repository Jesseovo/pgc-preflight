-- Keep old stage names and all immutable rows; only the opt-in harness may
-- create the second repair. Member protocol validation continues to reject it.
ALTER TABLE forge_creation_stages RENAME TO forge_creation_stages_before_harness;
DROP INDEX forge_creation_stages_topic;
CREATE TABLE forge_creation_stages (
 task_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('build','polish','repair','repair2')),
 owner_id TEXT NOT NULL, topic_id INTEGER NOT NULL, version_id TEXT NOT NULL UNIQUE,
 content_hash TEXT NOT NULL, input_hash TEXT, evidence_hash TEXT,
 evidence TEXT, self_check TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,stage)
);
INSERT INTO forge_creation_stages SELECT * FROM forge_creation_stages_before_harness;
DROP TABLE forge_creation_stages_before_harness;
CREATE INDEX forge_creation_stages_topic ON forge_creation_stages(owner_id,topic_id,created_at);
