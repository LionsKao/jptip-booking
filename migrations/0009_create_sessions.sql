-- Server-side login sessions. Issued by /api/otp/verify, checked on every
-- protected page/API request via the `session` HttpOnly cookie — replaces
-- the old client-only sessionStorage flag, which the server never verified.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
