-- calendar_events: stores real events synced from Google Calendar
-- Populated by sync-calendar.js (runs every 15 min on Sally)
-- Read by the PWA via anon key; written only by service role key

CREATE TABLE IF NOT EXISTS calendar_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_event_id TEXT        NOT NULL,
  calendar_id     TEXT        NOT NULL,
  calendar_name   TEXT        NOT NULL,   -- 'Rincon', 'Coastal Inn', 'Holiday'
  title           TEXT        NOT NULL,
  start_at        TIMESTAMPTZ NOT NULL,   -- all-day events stored as midnight UTC on that date
  end_at          TIMESTAMPTZ NOT NULL,
  all_day         BOOLEAN     NOT NULL DEFAULT FALSE,
  location        TEXT,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'confirmed',  -- confirmed | tentative | cancelled
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (google_event_id, calendar_id)
);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- App (anon key) can read events
CREATE POLICY "anon_read_events"
  ON calendar_events FOR SELECT TO anon USING (true);

-- synced_at is set explicitly by sync-calendar.js on every upsert — no trigger needed
