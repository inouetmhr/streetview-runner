CREATE TABLE IF NOT EXISTS history (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  heading REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS history_user_day_ts
  ON history (user_id, day, ts);
