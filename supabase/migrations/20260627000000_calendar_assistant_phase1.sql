-- Migration: calendar_assistant_phase1
-- Created:   2026-06-27
-- Author:    Neo (database specialist)
--
-- Adds the two tables that power the Calendar Assistant (Phase 1):
--   calendar_blocks  — Peter's recurring protected time slots, synced to Google Calendar.
--   tasks            — Flexible to-do items scheduled on the calendar; rescheduled_count
--                      feeds Phase 4 slip-pattern detection.
-- RLS is enabled on both tables and locked down by default.
-- No permissive policies are defined here — they will be added per-tool
-- as authentication is wired up.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: calendar_blocks
-- What it stores: Peter's recurring protected time slots — gym,
-- deep work, meeting windows, and partnership blocks. Each row
-- gets pushed to Google Calendar as a recurring event.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE calendar_blocks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL,
  day_of_week      INTEGER     NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0=Sunday, 6=Saturday
  start_time       TIME        NOT NULL,
  end_time         TIME        NOT NULL,
  block_type       TEXT        NOT NULL
                                 CHECK (block_type IN ('gym','deep_work','meeting_window','partnership')),
  color            TEXT,                   -- nullable — falls back to Google Calendar default
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  google_event_id  TEXT        UNIQUE,     -- nullable until pushed to Google Calendar
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT end_after_start CHECK (end_time > start_time)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE calendar_blocks ENABLE ROW LEVEL SECURITY;

-- Primary query pattern: fetch active blocks for a given day of week.
CREATE INDEX idx_calendar_blocks_day_active ON calendar_blocks(day_of_week, is_active);

-- Prevents duplicate Google Calendar event IDs while allowing multiple NULL rows
-- (NULL = not yet synced to Google Calendar).
CREATE UNIQUE INDEX idx_calendar_blocks_google_event_id
  ON calendar_blocks(google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE TRIGGER trg_calendar_blocks_updated_at
  BEFORE UPDATE ON calendar_blocks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: tasks
-- What it stores: to-do items Peter puts on his calendar.
-- Displayed gray on Google Calendar. due_time NULL means all-day.
-- rescheduled_count is incremented each time a task is pushed
-- to a later date — feeds Phase 4 slip-pattern detection.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE tasks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT        NOT NULL,
  description       TEXT,                  -- nullable — short tasks may not need one
  due_date          DATE        NOT NULL,
  due_time          TIME,                  -- nullable — NULL means all-day task
  status            TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','done','snoozed')),
  priority          TEXT        NOT NULL DEFAULT 'admin'
                                  CHECK (priority IN ('strategic','decision','relationship','admin')),
  rescheduled_count INTEGER     NOT NULL DEFAULT 0 CHECK (rescheduled_count >= 0),
  google_event_id   TEXT        UNIQUE,    -- nullable until pushed to Google Calendar
  source            TEXT        NOT NULL DEFAULT 'manual'
                                  CHECK (source IN ('manual','voice','email')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Dominant query pattern: open/snoozed tasks ordered by due date.
CREATE INDEX idx_tasks_status_due_date ON tasks(status, due_date);

-- Phase 4 slip-pattern queries: find tasks that keep getting pushed.
CREATE INDEX idx_tasks_rescheduled_count ON tasks(rescheduled_count DESC);

-- Priority filtering — used when surfacing what matters most today.
CREATE INDEX idx_tasks_priority ON tasks(priority);

-- Prevents duplicate Google Calendar event IDs while allowing multiple NULL rows
-- (NULL = not yet synced to Google Calendar).
CREATE UNIQUE INDEX idx_tasks_google_event_id
  ON tasks(google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_tasks_updated_at          ON tasks;
-- DROP TRIGGER IF EXISTS trg_calendar_blocks_updated_at ON calendar_blocks;
--
-- DROP INDEX IF EXISTS idx_tasks_google_event_id;
-- DROP INDEX IF EXISTS idx_tasks_priority;
-- DROP INDEX IF EXISTS idx_tasks_rescheduled_count;
-- DROP INDEX IF EXISTS idx_tasks_status_due_date;
--
-- DROP INDEX IF EXISTS idx_calendar_blocks_google_event_id;
-- DROP INDEX IF EXISTS idx_calendar_blocks_day_active;
--
-- DROP TABLE IF EXISTS tasks;
-- DROP TABLE IF EXISTS calendar_blocks;
--
-- ============================================================
