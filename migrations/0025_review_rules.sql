-- Rule content is immutable; only explicit admin publication can activate a draft.
CREATE TABLE review_rule_versions (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX review_rule_versions_created ON review_rule_versions(created_at DESC);
CREATE TABLE review_rule_head (id INTEGER PRIMARY KEY CHECK(id=1), version_id TEXT REFERENCES review_rule_versions(id));
INSERT INTO review_rule_head(id,version_id) VALUES(1,NULL);
CREATE TRIGGER review_rule_content_immutable BEFORE UPDATE ON review_rule_versions
WHEN NEW.id IS NOT OLD.id OR NEW.content_hash IS NOT OLD.content_hash OR NEW.snapshot IS NOT OLD.snapshot OR NEW.created_at IS NOT OLD.created_at OR OLD.published_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'rule versions are immutable'); END;
CREATE TRIGGER review_rule_no_delete BEFORE DELETE ON review_rule_versions
BEGIN SELECT RAISE(ABORT,'rule versions are immutable'); END;
ALTER TABLE review_jobs ADD COLUMN rules_snapshot TEXT;
ALTER TABLE reviews ADD COLUMN rules_snapshot TEXT;
ALTER TABLE review_jobs ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE review_jobs ADD COLUMN report_schema_version INTEGER NOT NULL DEFAULT 1;
