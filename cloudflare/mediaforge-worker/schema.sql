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

-- Hard safety guard for the Cloudflare R2 Standard free tier.
-- Cloudflare currently includes 10 GB-month/month; MediaForge reserves 1 GB of headroom
-- and refuses new uploads when ready + in-progress declared storage would exceed 9 GB.
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
