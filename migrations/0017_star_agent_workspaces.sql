ALTER TABLE members ADD COLUMN star INTEGER NOT NULL DEFAULT 0 CHECK(star IN (0,1));
ALTER TABLE topics ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE topics ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE topics ADD COLUMN requirements TEXT NOT NULL DEFAULT '';
ALTER TABLE games ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE games ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
-- Rebuild to replace the old global external-ID constraint with an owner scope.
CREATE TABLE games_owned (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ext_id TEXT, title TEXT NOT NULL,
 descr TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'local', score INTEGER,
 aes INTEGER, ease INTEGER, play INTEGER, revisions INTEGER NOT NULL DEFAULT 1,
 feedback TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '',
 gesture TEXT NOT NULL DEFAULT '', structure TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'mine', updated_at TEXT,
 owner_id TEXT NOT NULL DEFAULT 'admin', is_public INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner_id,ext_id)
);
INSERT INTO games_owned SELECT * FROM games;
DROP TABLE games;
ALTER TABLE games_owned RENAME TO games;
CREATE INDEX games_owner ON games(owner_id,id);
CREATE INDEX topics_owner ON topics(owner_id,id);
CREATE TABLE subject_reservations(subject_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
INSERT OR IGNORE INTO subject_reservations
 SELECT lower(trim(subject)),coalesce(updated_at,datetime('now')) FROM games WHERE trim(subject)<>'';
INSERT OR IGNORE INTO subject_reservations
 SELECT lower(trim(subject)),created_at FROM topics WHERE trim(subject)<>'';
CREATE TRIGGER reserve_topic_subject AFTER INSERT ON topics WHEN trim(NEW.subject)<>'' BEGIN
 INSERT OR IGNORE INTO subject_reservations VALUES(lower(trim(NEW.subject)),NEW.created_at);
END;
CREATE TRIGGER reserve_game_subject AFTER INSERT ON games WHEN trim(NEW.subject)<>'' BEGIN
 INSERT OR IGNORE INTO subject_reservations VALUES(lower(trim(NEW.subject)),coalesce(NEW.updated_at,datetime('now')));
END;
CREATE TRIGGER reserve_changed_game_subject AFTER UPDATE OF subject ON games WHEN trim(NEW.subject)<>'' BEGIN
 INSERT OR IGNORE INTO subject_reservations VALUES(lower(trim(NEW.subject)),coalesce(NEW.updated_at,datetime('now')));
END;
ALTER TABLE forge_tasks ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE forge_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE forge_tasks ADD COLUMN device_id TEXT;
ALTER TABLE forge_tasks ADD COLUMN claim_id TEXT;
ALTER TABLE forge_tasks ADD COLUMN receipt_hash TEXT;
ALTER TABLE forge_tasks ADD COLUMN input_snapshot TEXT;
ALTER TABLE forge_tasks ADD COLUMN result_hash TEXT;
CREATE INDEX forge_tasks_owner ON forge_tasks(owner_id,executor,status);
CREATE TABLE forge_agent_pairings(code_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_version INTEGER NOT NULL,expires_at TEXT NOT NULL,device_id TEXT);
CREATE TABLE forge_agents(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_version INTEGER NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,pairing_hash TEXT NOT NULL,name TEXT NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,last_seen TEXT
);
CREATE INDEX forge_agents_owner ON forge_agents(owner_id,revoked);
CREATE TABLE forge_requests(owner_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT,PRIMARY KEY(owner_id,request_id));
CREATE TABLE artifact_versions(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,topic_id INTEGER NOT NULL,kind TEXT NOT NULL,
 content TEXT NOT NULL,task_id TEXT UNIQUE,input_revision INTEGER NOT NULL,input_versions TEXT NOT NULL DEFAULT '{}',policy_revision INTEGER NOT NULL DEFAULT 0,
 executor TEXT NOT NULL,device_id TEXT,model TEXT NOT NULL DEFAULT '',disposition TEXT NOT NULL,
 restored_from TEXT,created_at TEXT NOT NULL
);
CREATE INDEX artifact_versions_topic ON artifact_versions(owner_id,topic_id,kind,created_at);
CREATE TABLE artifact_heads(topic_id INTEGER NOT NULL,kind TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(topic_id,kind));
INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at)
 SELECT 'legacy-expand-'||id,owner_id,id,'expand',data,0,'platform','current',created_at FROM topics WHERE json_extract(data,'$.title') IS NOT NULL;
INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at)
 SELECT 'legacy-brief-'||id,owner_id,id,'brief',brief_md,0,'platform','current',updated_at FROM topics WHERE brief_md IS NOT NULL;
INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at)
 SELECT 'legacy-preview-'||id,owner_id,id,'preview',preview_svg,0,'platform','current',updated_at FROM topics WHERE preview_svg IS NOT NULL;
INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at)
 SELECT 'legacy-assets-'||id,owner_id,id,'assets',assets_html,0,'platform','current',updated_at FROM topics WHERE assets_html IS NOT NULL;
INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at)
 SELECT 'legacy-game-'||id,owner_id,id,'game',product_html,0,'platform','current',updated_at FROM topics WHERE product_html IS NOT NULL;
INSERT INTO artifact_heads SELECT topic_id,kind,id FROM artifact_versions;
CREATE TABLE vocab_suggestions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE,dim TEXT NOT NULL,words TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
-- This counter is part of every creation input. Changes in public materials
-- must not silently publish a result generated from an older policy snapshot.
CREATE TABLE workspace_policy_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO workspace_policy_revision VALUES(1,0);
CREATE TRIGGER workspace_settings_insert AFTER INSERT ON settings WHEN NEW.id!='model' BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_settings_update AFTER UPDATE ON settings WHEN OLD.id!='model' OR NEW.id!='model' BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_settings_delete AFTER DELETE ON settings WHEN OLD.id!='model' BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_vocab_insert AFTER INSERT ON vocab BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_vocab_update AFTER UPDATE ON vocab BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_vocab_delete AFTER DELETE ON vocab BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_public_game_insert AFTER INSERT ON games WHEN NEW.is_public=1 BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_public_game_update AFTER UPDATE ON games WHEN OLD.is_public=1 OR NEW.is_public=1 BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER workspace_public_game_delete AFTER DELETE ON games WHEN OLD.is_public=1 BEGIN
 UPDATE workspace_policy_revision SET revision=revision+1 WHERE id=1;
END;
ALTER TABLE review_jobs ADD COLUMN model_executor TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE review_jobs ADD COLUMN local_draft TEXT;
ALTER TABLE review_jobs ADD COLUMN local_model TEXT;
ALTER TABLE review_jobs ADD COLUMN local_result_hash TEXT;
ALTER TABLE reviews ADD COLUMN model_executor TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE reviews ADD COLUMN agent_id TEXT;
ALTER TABLE reviews ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE reviews ADD COLUMN evidence_hash TEXT;
