-- Enrollment is research metadata, separate from member permissions and sessions.
CREATE TABLE review_pilot_members (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  pilot_enabled INTEGER NOT NULL CHECK(pilot_enabled IN (0,1)),
  creator_account TEXT NOT NULL CHECK(length(creator_account)<=120),
  revision INTEGER NOT NULL CHECK(revision>=1),
  enrollment_started_at TEXT,
  updated_at TEXT NOT NULL,
  binding_status TEXT NOT NULL DEFAULT 'none' CHECK(binding_status IN ('none','linked','stale')),
  source_author_id TEXT UNIQUE,
  work_id TEXT,
  version_id TEXT,
  verified_at TEXT,
  source_generation INTEGER,
  scope_revision INTEGER,
  CHECK((binding_status='linked' AND source_author_id IS NOT NULL AND work_id IS NOT NULL AND version_id IS NOT NULL
    AND verified_at IS NOT NULL AND source_generation IS NOT NULL AND scope_revision IS NOT NULL)
    OR (binding_status<>'linked' AND source_author_id IS NULL AND work_id IS NULL AND version_id IS NULL
    AND verified_at IS NULL AND source_generation IS NULL AND scope_revision IS NULL))
);
CREATE INDEX review_pilot_members_work ON review_pilot_members(work_id) WHERE binding_status='linked';

-- Receipts also retain enrollment history, without past source identities.
CREATE TABLE review_pilot_requests (
  request_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  pilot_enabled INTEGER NOT NULL CHECK(pilot_enabled IN (0,1)),
  enrollment_started_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX review_pilot_requests_member ON review_pilot_requests(member_id);

CREATE TRIGGER review_pilot_members_source_removed AFTER DELETE ON creator_feedback_games
BEGIN
  UPDATE review_pilot_members SET binding_status='stale',source_author_id=NULL,work_id=NULL,version_id=NULL,
    verified_at=NULL,source_generation=NULL,scope_revision=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE work_id=OLD.game_id AND binding_status='linked';
END;

CREATE TRIGGER review_pilot_members_source_changed AFTER UPDATE OF generation,scope_revision,credential_hash,status ON creator_feedback_state
WHEN NEW.generation<>OLD.generation OR NEW.scope_revision IS NOT OLD.scope_revision OR NEW.credential_hash IS NOT OLD.credential_hash
  OR (NEW.status IN ('auth_revoked','disabled') AND NEW.status<>OLD.status)
BEGIN
  UPDATE review_pilot_members SET binding_status='stale',source_author_id=NULL,work_id=NULL,version_id=NULL,
    verified_at=NULL,source_generation=NULL,scope_revision=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE binding_status='linked';
END;
