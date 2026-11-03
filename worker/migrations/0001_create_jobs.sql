CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  status        TEXT NOT NULL,      -- uploading | queued | processing | completed | failed
  attempt       INTEGER NOT NULL DEFAULT 0,
  retries_left  INTEGER NOT NULL DEFAULT 2,
  options       TEXT NOT NULL,      -- JSON: 話者分離、話者数、用語リスト
  speaker_names TEXT NOT NULL DEFAULT '{}', -- JSON: { "SPEAKER_00": "田中" }
  error_code    TEXT,
  duration_sec  REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  expires_at    TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_expires_at ON jobs(expires_at);
