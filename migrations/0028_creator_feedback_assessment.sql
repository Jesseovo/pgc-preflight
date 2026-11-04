-- Independent administrator provenance; never writes AI reports or gallery state.
CREATE TABLE creator_feedback_assessments (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, game_id TEXT NOT NULL, version_id TEXT NOT NULL,
 generation INTEGER NOT NULL, scope_revision INTEGER NOT NULL, link_created_at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('declaration','file')), payload TEXT NOT NULL,
 payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(task_id,request_id)
);
CREATE INDEX creator_feedback_assessments_task ON creator_feedback_assessments(task_id,generation,created_at,id);
CREATE INDEX creator_feedback_assessments_game ON creator_feedback_assessments(game_id);
CREATE TRIGGER creator_feedback_assessments_immutable BEFORE UPDATE ON creator_feedback_assessments
 BEGIN SELECT RAISE(ABORT,'feedback assessment is immutable'); END;
CREATE TRIGGER creator_feedback_assessments_unlink AFTER DELETE ON creator_feedback_links
 BEGIN DELETE FROM creator_feedback_assessments WHERE task_id=OLD.task_id; END;
CREATE TRIGGER creator_feedback_assessments_remove AFTER DELETE ON creator_feedback_games
 BEGIN DELETE FROM creator_feedback_assessments WHERE game_id=OLD.game_id; END;
CREATE TRIGGER creator_feedback_assessments_generation AFTER UPDATE OF generation ON creator_feedback_state
 WHEN NEW.generation<>OLD.generation
 BEGIN DELETE FROM creator_feedback_assessments WHERE generation<>NEW.generation; END;
