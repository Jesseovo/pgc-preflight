-- Existing locked tasks keep their original execution contract.
ALTER TABLE forge_tasks ADD COLUMN creative_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE forge_tasks ADD COLUMN phase TEXT;
ALTER TABLE forge_tasks ADD COLUMN phase_started_at TEXT;
CREATE TABLE forge_creation_stages (
 task_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('build','polish','repair')),
 owner_id TEXT NOT NULL, topic_id INTEGER NOT NULL, version_id TEXT NOT NULL UNIQUE,
 content_hash TEXT NOT NULL, input_hash TEXT, evidence_hash TEXT,
 evidence TEXT, self_check TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,stage)
);
CREATE INDEX forge_creation_stages_topic ON forge_creation_stages(owner_id,topic_id,created_at);
CREATE TABLE forge_creation_evidence (
 task_id TEXT NOT NULL, stage TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL,
 PRIMARY KEY(task_id,stage,part)
);
