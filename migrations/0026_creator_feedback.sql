-- Provider opinions are an administrator-private cache, never AI review input.
CREATE TABLE IF NOT EXISTS creator_feedback_state (
 id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL DEFAULT 0,
 credential_hash TEXT, scope_revision INTEGER, status TEXT NOT NULL DEFAULT 'disabled',
 phase TEXT NOT NULL DEFAULT 'snapshot', pending_key TEXT, snapshot_id TEXT,
 snapshot_cursor TEXT, snapshot_after TEXT, snapshot_expires_at TEXT, cursor TEXT,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 last_success_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO creator_feedback_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS creator_feedback_games (
 game_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL DEFAULT -1,
 representation TEXT NOT NULL DEFAULT 'query-time-current-state', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_feedback_chunks (
 kind TEXT NOT NULL, entity_id TEXT NOT NULL, game_id TEXT,
 part INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(kind,entity_id,part)
);
CREATE INDEX IF NOT EXISTS creator_feedback_chunks_game ON creator_feedback_chunks(game_id);
CREATE TABLE IF NOT EXISTS creator_feedback_events (
 event_id INTEGER PRIMARY KEY, game_id TEXT
);
CREATE TABLE IF NOT EXISTS creator_feedback_links (
 task_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, version_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, known_work_id TEXT NOT NULL, known_submission_id TEXT NOT NULL,
 matched_by TEXT NOT NULL, scope_revision INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS creator_feedback_links_game ON creator_feedback_links(game_id);
