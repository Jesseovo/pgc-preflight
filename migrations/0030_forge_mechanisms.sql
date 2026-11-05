ALTER TABLE topics ADD COLUMN creative_version INTEGER NOT NULL DEFAULT 1;

-- Preserve legacy reservation behavior without letting private v2 seeds or
-- selected v2 mechanisms affect the legacy subject list.
DROP TRIGGER reserve_topic_subject;
CREATE TRIGGER reserve_topic_subject AFTER INSERT ON topics
WHEN NEW.creative_version=1 AND trim(NEW.subject)<>'' BEGIN
 INSERT OR IGNORE INTO subject_reservations VALUES(lower(trim(NEW.subject)),NEW.created_at);
END;

CREATE TABLE forge_mechanism_revision (
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL
);
INSERT INTO forge_mechanism_revision VALUES(1,0);

CREATE TABLE forge_mechanism_checks (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 source_topic_id INTEGER NOT NULL,
 candidate_index INTEGER NOT NULL,
 version_id TEXT NOT NULL,
 content_revision INTEGER NOT NULL,
 registry_revision INTEGER NOT NULL,
 signature TEXT NOT NULL,
 candidate TEXT NOT NULL,
 matches TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','exact','no_matches','distinct','duplicate','uncertain')),
 executor TEXT NOT NULL CHECK(executor IN ('platform','agent')),
 device_id TEXT,
 model TEXT,
 judgment TEXT,
 created_at TEXT NOT NULL
);

CREATE TABLE forge_mechanisms (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 check_id TEXT UNIQUE,
 source_topic_id INTEGER,
 candidate_index INTEGER,
 publication_id TEXT UNIQUE,
 topic_id INTEGER UNIQUE,
 signature TEXT NOT NULL UNIQUE,
 subject TEXT NOT NULL,
 action TEXT NOT NULL,
 rule TEXT NOT NULL,
 structure TEXT NOT NULL,
 UNIQUE(source_topic_id,candidate_index),
 CHECK((check_id IS NOT NULL AND source_topic_id IS NOT NULL AND candidate_index IS NOT NULL AND publication_id IS NULL)
    OR (publication_id IS NOT NULL AND check_id IS NULL AND source_topic_id IS NULL AND candidate_index IS NULL AND topic_id IS NULL))
);

CREATE TABLE forge_mechanism_admin_resolutions (
 check_id TEXT PRIMARY KEY REFERENCES forge_mechanism_checks(id),
 verdict TEXT NOT NULL CHECK(verdict IN ('distinct','duplicate','uncertain')),
 reason TEXT NOT NULL,
 comparisons TEXT,
 created_at TEXT NOT NULL
);

CREATE TABLE forge_mechanism_publications (
 id TEXT PRIMARY KEY,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL
);

CREATE TRIGGER forge_mechanisms_insert AFTER INSERT ON forge_mechanisms BEGIN
 UPDATE forge_mechanism_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER forge_mechanisms_update AFTER UPDATE OF subject,action,rule,structure,signature ON forge_mechanisms BEGIN
 UPDATE forge_mechanism_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER forge_mechanisms_delete AFTER DELETE ON forge_mechanisms BEGIN
 UPDATE forge_mechanism_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TABLE forge_mechanism_terms (
 term TEXT NOT NULL,
 mechanism_id INTEGER NOT NULL REFERENCES forge_mechanisms(id) ON DELETE CASCADE,
 PRIMARY KEY(term,mechanism_id)
) WITHOUT ROWID;
CREATE INDEX forge_mechanism_terms_by_mechanism ON forge_mechanism_terms(mechanism_id);
