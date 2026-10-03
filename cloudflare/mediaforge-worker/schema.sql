CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'loop',
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  download_token TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

CREATE TRIGGER IF NOT EXISTS trg_assets_r2_free_tier_guard
BEFORE INSERT ON assets
WHEN NEW.status IN ('uploading','ready')
  AND (
    COALESCE((SELECT SUM(size_bytes) FROM assets WHERE status IN ('uploading','ready')), 0)
    + NEW.size_bytes
  ) > 9000000000
BEGIN
  SELECT RAISE(ABORT, 'mediaforge_r2_free_tier_guard_9gb');
END;

CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER,
  track_ids_json TEXT NOT NULL,
  visual_asset_id TEXT,
  github_run_id INTEGER,
  github_run_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  live_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_created_at ON live_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status);

CREATE TABLE IF NOT EXISTS live_session_assets (
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (session_id, role)
);

CREATE INDEX IF NOT EXISTS idx_live_session_assets_session ON live_session_assets(session_id);


CREATE TABLE IF NOT EXISTS live_runtime (
  session_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL DEFAULT 'ovh',
  runtime_slot TEXT,
  last_status_at TEXT,
  agent_status_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_live_runtime_slot ON live_runtime(runtime_slot);

CREATE TABLE IF NOT EXISTS ovh_state (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ovh_state_updated_at ON ovh_state(updated_at DESC);
