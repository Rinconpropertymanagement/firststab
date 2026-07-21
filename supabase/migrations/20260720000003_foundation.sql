-- ============================================================
-- Migration: 20260720000003_foundation
-- Created:   2026-07-21
-- Author:    Neo (database specialist)
--
-- Establishes the 9 foundation tables for the Rincon Management
-- workflow system.
--
-- Table creation order (dependency order — each table depends only on
-- tables that appear before it in this file):
--   1. users
--   2. workflow_instances  (depends on: users)
--   3. tasks               (depends on: users, workflow_instances)
--   4. scheduled_events    (depends on: workflow_instances)
--   5. communications_log  (depends on: workflow_instances, users)
--   6. audit_log           (depends on: users)
--   7. contacts            (depends on existing tables: units, tenants)
--   8. vendors             (no new-table dependencies)
--   9. documents           (depends on: users)
--
-- Additional changes in this migration:
--   - CREATE OR REPLACE VIEW owner_summary  (replaces owners.total_units with live calculation)
--   - ALTER TABLE owners DROP COLUMN total_units
--
-- ============================================================
-- SYNC CONFLICT RULE
-- ============================================================
-- AppFolio is the source of truth for a specific set of fields.
-- The nightly sync OVERWRITES those fields every run. The workflow
-- system owns all other fields. The sync script MUST NEVER touch
-- system-owned fields — upserts must enumerate only the columns
-- listed below in the DO UPDATE SET clause. Never use DO UPDATE SET *.
--
-- Fields owned by AppFolio (sync may overwrite these):
--   properties:           name, address, city, state, zip, unit_count
--   units:                unit_number, bedrooms, bathrooms, sqft, monthly_rent
--   tenants:              first_name, last_name, email, phone
--   leases:               lease_start, lease_end, monthly_rent, status
--   maintenance_requests: title, description, status, vendor_name, cost, completed_at
--
-- All other fields on those tables, and all fields on the 9 tables
-- below, are system-owned. The sync script must never write to them.
-- ============================================================
--
-- ============================================================
-- CCPA NOTE — audit_log
-- ============================================================
-- When a tenant submits a CCPA deletion request, PII in all other
-- tables must be anonymized (name, email, phone replaced with
-- "[REDACTED]"). However, audit_log rows are RETAINED for audit
-- continuity — entity_id is preserved. Any PII stored inside the
-- details JSONB field on audit_log must be replaced with the string
-- "[REDACTED]" in a targeted UPDATE, not deleted.
-- Basis: Cal. Civ. Code § 1798.105(d)(9) — security and fraud
-- prevention exemption permits retention of audit trails.
-- ============================================================
--
-- RLS: enabled on all 9 tables, locked down by default.
-- No permissive policies are defined here. They will be added
-- per-tool as authentication is wired up, scoped to authenticated
-- users only.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: users
-- What it stores: one row per Rincon Management team member.
-- No passwords are stored here. Authentication is handled separately
-- (Supabase Auth or external IdP). This table carries identity,
-- role, and pod metadata only.
-- pod is NULL for Executive, Operations, and Business Development
-- roles — only the 4 Pod roles belong to Solimar or Faria.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  email        TEXT        NOT NULL,
  role         TEXT        NOT NULL CHECK (role IN (
                 'CEO',
                 'Director of Operations',
                 'Project Manager / Bookkeeper',
                 'Property Manager',
                 'Maintenance Coordinator',
                 'Transaction Coordinator',
                 'Resident Services Coordinator',
                 'Business Development Manager',
                 'Business Development Coordinator',
                 'Marketing Coordinator'
               )),
  pod          TEXT        CHECK (pod IN ('Solimar', 'Faria')),  -- null for non-pod roles
  department   TEXT        NOT NULL CHECK (department IN (
                 'Executive',
                 'Operations',
                 'Pod',
                 'Business Development'
               )),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Unique index on email: prevents duplicate team member records.
-- Also used as the lookup key when wiring up authentication.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: workflow_instances
-- What it stores: one row per running workflow process. A workflow
-- is created when the system detects a trigger condition (e.g. a
-- lease expiring in 60 days) and tracks its full lifecycle.
-- created_by is NULL for system-initiated workflows (cron, nightly job).
-- metadata holds per-workflow-type data — structure varies by
-- workflow_type (e.g. notice dates, prior step outputs, flags).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_instances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type   TEXT        NOT NULL,    -- e.g. "insurance_compliance", "lease_renewal", "move_in"
  entity_type     TEXT        NOT NULL,    -- e.g. "lease", "tenant", "unit", "vendor"
  entity_id       UUID        NOT NULL,    -- UUID of the record this workflow is running against
  status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'completed', 'cancelled', 'failed')),
  current_step    INTEGER,                 -- nullable — which numbered step the workflow is on
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,            -- null until the workflow reaches a terminal status
  created_by      UUID        REFERENCES users(id),  -- null = system-initiated
  metadata        JSONB,                  -- flexible per-run data; structure defined per workflow_type
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_workflow_instances_entity        ON workflow_instances(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_status        ON workflow_instances(status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_workflow_type ON workflow_instances(workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_created_by    ON workflow_instances(created_by)
  WHERE created_by IS NOT NULL;

DROP TRIGGER IF EXISTS trg_workflow_instances_updated_at ON workflow_instances;
CREATE TRIGGER trg_workflow_instances_updated_at
  BEFORE UPDATE ON workflow_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: tasks
-- What it stores: actionable to-do items generated by workflows
-- and assigned to team members. Tasks can also be created manually
-- (workflow_instance_id is nullable for manual tasks).
-- completed_at and completed_by must be set together when
-- status transitions to 'completed'.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT        NOT NULL,
  description          TEXT,                    -- nullable — additional detail for the assignee
  status               TEXT        NOT NULL DEFAULT 'open'
                                     CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  priority             TEXT        NOT NULL DEFAULT 'medium'
                                     CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assigned_to          UUID        REFERENCES users(id),              -- nullable — unassigned until claimed
  due_date             DATE,                    -- nullable
  entity_type          TEXT        NOT NULL,    -- what record this task is about (e.g. "lease", "unit")
  entity_id            UUID        NOT NULL,    -- UUID of that record
  workflow_instance_id UUID        REFERENCES workflow_instances(id), -- null = manually created
  completed_at         TIMESTAMPTZ,            -- set when status → 'completed'
  completed_by         UUID        REFERENCES users(id),              -- set when status → 'completed'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to          ON tasks(assigned_to)          WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_status               ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date             ON tasks(due_date)              WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_entity               ON tasks(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow_instance_id ON tasks(workflow_instance_id)  WHERE workflow_instance_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: scheduled_events
-- What it stores: time-based triggers consumed by a nightly cron
-- job on Sally. The job queries:
--   SELECT * FROM scheduled_events
--   WHERE fired_at IS NULL AND fire_at <= NOW()
-- executes the handler for each event_type, then sets fired_at.
-- Events are never deleted — fired_at IS NOT NULL means consumed.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type           TEXT        NOT NULL,    -- e.g. "send_renewal_reminder", "check_insurance_expiry"
  fire_at              TIMESTAMPTZ NOT NULL,    -- when this event should be triggered
  entity_type          TEXT        NOT NULL,
  entity_id            UUID        NOT NULL,
  workflow_instance_id UUID        REFERENCES workflow_instances(id), -- nullable
  fired_at             TIMESTAMPTZ,            -- null = not yet fired; set by the nightly job on execution
  payload              JSONB,                  -- nullable — extra data the event handler needs
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE scheduled_events ENABLE ROW LEVEL SECURITY;

-- Primary nightly query: "give me everything due that hasn't fired yet."
-- Partial index covers only unfired rows — keeps the index small as
-- the table grows over months of operation.
CREATE INDEX IF NOT EXISTS idx_scheduled_events_pending
  ON scheduled_events(fire_at)
  WHERE fired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_events_entity               ON scheduled_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_events_workflow_instance_id ON scheduled_events(workflow_instance_id)
  WHERE workflow_instance_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_scheduled_events_updated_at ON scheduled_events;
CREATE TRIGGER trg_scheduled_events_updated_at
  BEFORE UPDATE ON scheduled_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: communications_log
-- What it stores: every email and text sent by the system or by
-- a team member through a system workflow. Permanent record —
-- rows are never deleted.
-- body_preview stores the first 500 characters only. The application
-- must truncate before inserting; this table does not enforce it.
-- sent_by is NULL for fully automated (system-generated) messages.
-- notice_type is NULL for non-legal messages. Legal notices must
-- always set this field — it enables audit queries like
-- "show all 3-day notices sent in the last 90 days."
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS communications_log (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel              TEXT        NOT NULL CHECK (channel IN ('email', 'sms')),
  to_address           TEXT        NOT NULL,   -- email address or phone number — no name stored here
  subject              TEXT,                   -- nullable — emails only; null for SMS
  body_preview         TEXT,                   -- first 500 chars; application truncates before insert
  status               TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('sent', 'failed', 'pending')),
  sent_at              TIMESTAMPTZ,            -- null until the send is confirmed
  entity_type          TEXT        NOT NULL,
  entity_id            UUID        NOT NULL,
  workflow_instance_id UUID        REFERENCES workflow_instances(id), -- nullable
  sent_by              UUID        REFERENCES users(id),              -- null = system-generated
  notice_type          TEXT        CHECK (notice_type IN (
                         '3_day_notice',
                         '30_day_notice',
                         '60_day_notice',
                         '90_day_notice'
                       )),                     -- null for non-legal messages
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE communications_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_communications_log_entity               ON communications_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_communications_log_workflow_instance_id ON communications_log(workflow_instance_id)
  WHERE workflow_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communications_log_sent_at              ON communications_log(sent_at)
  WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communications_log_status               ON communications_log(status);
-- Partial index: only legal notices need to be queried by notice_type
CREATE INDEX IF NOT EXISTS idx_communications_log_notice_type          ON communications_log(notice_type)
  WHERE notice_type IS NOT NULL;

DROP TRIGGER IF EXISTS trg_communications_log_updated_at ON communications_log;
CREATE TRIGGER trg_communications_log_updated_at
  BEFORE UPDATE ON communications_log
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: audit_log
-- What it stores: append-only record of every action taken by
-- the system or a team member. NEVER updated. NEVER deleted.
-- No updated_at column or trigger — rows are immutable after insert.
-- performed_by is NULL for automated system actions.
-- details is a flexible JSONB payload whose structure varies by
-- action type (e.g. {"old_status": "active", "new_status": "expired"}).
--
-- CCPA deletion procedure:
--   Do NOT delete rows. Instead, run a targeted UPDATE on rows
--   where details contains the affected tenant's data, replacing
--   PII values with the string "[REDACTED]". entity_id is preserved.
--   Example:
--     UPDATE audit_log
--     SET details = jsonb_strip_nulls(details) || '{"email":"[REDACTED]","name":"[REDACTED]"}'
--     WHERE entity_type = 'tenant' AND entity_id = '<tenant_uuid>';
--   Adjust the JSONB keys per the action type stored in details.
--
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action        TEXT        NOT NULL,    -- e.g. "lease.renewed", "task.completed", "insurance.expired"
  entity_type   TEXT        NOT NULL,    -- e.g. "lease", "tenant", "unit"
  entity_id     UUID        NOT NULL,    -- UUID of the affected record
  performed_by  UUID        REFERENCES users(id), -- null = system action
  details       JSONB,                  -- flexible payload; CCPA: replace PII with "[REDACTED]"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at — this table is append-only and rows must never be modified
  -- except for the CCPA [REDACTED] procedure described above.
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_audit_log_entity       ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_performed_by ON audit_log(performed_by)  WHERE performed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_action       ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at   ON audit_log(created_at);


-- ============================================================
-- TABLE: contacts
-- What it stores: people who are not tenants — prospects,
-- applicants, co-signers, emergency contacts, and guarantors.
-- A contact can be linked to a unit, a tenant, or neither.
-- Fair Housing: do NOT add columns for race, religion, sex,
-- national origin, familial status, disability, source of income,
-- sexual orientation, gender identity, age, or immigration status.
-- appfolio_id is nullable — contacts are often entered manually.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name         TEXT        NOT NULL,
  last_name          TEXT        NOT NULL,
  email              TEXT,                          -- nullable
  phone              TEXT,                          -- nullable
  contact_type       TEXT        NOT NULL CHECK (contact_type IN (
                       'prospect',
                       'applicant',
                       'co_signer',
                       'emergency_contact',
                       'guarantor'
                     )),
  related_unit_id    UUID        REFERENCES units(id),    -- nullable
  related_tenant_id  UUID        REFERENCES tenants(id),  -- nullable
  notes              TEXT,                          -- nullable
  appfolio_id        TEXT,                          -- nullable — set if synced from AppFolio
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Partial unique index: prevents duplicates from AppFolio sync while
-- allowing multiple manually-entered rows (appfolio_id = NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_appfolio_id
  ON contacts(appfolio_id)
  WHERE appfolio_id IS NOT NULL;

-- Explicit unique constraint: required by Supabase REST API for
-- ON CONFLICT (appfolio_id) DO UPDATE upsert operations.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_appfolio_id_unique UNIQUE (appfolio_id);

CREATE INDEX IF NOT EXISTS idx_contacts_email             ON contacts(email)             WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_related_unit_id   ON contacts(related_unit_id)   WHERE related_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_related_tenant_id ON contacts(related_tenant_id) WHERE related_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_contact_type      ON contacts(contact_type);

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON contacts;
CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: vendors
-- What it stores: vendors used for maintenance and inspections.
-- insurance_expiry is the key field for compliance workflows —
-- the nightly job checks this date and creates tasks before
-- coverage lapses.
-- appfolio_id is nullable — vendors are often entered manually.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS vendors (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name            TEXT        NOT NULL,
  contact_name            TEXT,                          -- nullable — primary contact at the company
  email                   TEXT,                          -- nullable
  phone                   TEXT,                          -- nullable
  trade                   TEXT,                          -- nullable — e.g. "plumber", "electrician", "hvac", "general"
  license_number          TEXT,                          -- nullable
  insurance_expiry        DATE,                          -- nullable — triggers compliance alert workflow
  insurance_policy_number TEXT,                          -- nullable
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                   TEXT,                          -- nullable
  appfolio_id             TEXT,                          -- nullable
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

-- Partial unique index + explicit constraint for Supabase upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_appfolio_id
  ON vendors(appfolio_id)
  WHERE appfolio_id IS NOT NULL;

ALTER TABLE vendors
  ADD CONSTRAINT vendors_appfolio_id_unique UNIQUE (appfolio_id);

CREATE INDEX IF NOT EXISTS idx_vendors_trade            ON vendors(trade)             WHERE trade IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_is_active        ON vendors(is_active);
-- Partial index: only vendors with an insurance date need expiry queries
CREATE INDEX IF NOT EXISTS idx_vendors_insurance_expiry ON vendors(insurance_expiry)  WHERE insurance_expiry IS NOT NULL;

DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: documents
-- What it stores: metadata for files physically stored on Sally
-- at /var/www/documents/ organized by type and year.
--
-- Naming convention for file_path:
--   /var/www/documents/<file_type>/<year>/<descriptive-filename>
-- Examples:
--   /var/www/documents/insurance_certificate/2026/cert-vendor-abc123.pdf
--   /var/www/documents/inspection_report/2026/inspection-unit-7b-2026-07.pdf
--   /var/www/documents/notice/2026/3day-tenant-xyz-2026-07-21.pdf
--
-- The file itself lives on Sally. This table stores the metadata
-- so Supabase queries can locate, filter, and link documents to
-- records without touching the filesystem.
--
-- appfolio_id is nullable — most documents originate from the
-- workflow system, not AppFolio.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name        TEXT        NOT NULL,   -- e.g. "cert-vendor-abc123.pdf"
  file_path        TEXT        NOT NULL,   -- absolute path on Sally
  file_type        TEXT        NOT NULL,   -- e.g. "insurance_certificate", "lease", "inspection_report", "photo", "notice"
  mime_type        TEXT,                   -- nullable — e.g. "application/pdf", "image/jpeg"
  file_size_bytes  INTEGER,               -- nullable
  entity_type      TEXT        NOT NULL,   -- what record this document belongs to
  entity_id        UUID        NOT NULL,   -- UUID of that record
  uploaded_by      UUID        REFERENCES users(id), -- nullable — null when uploaded by sync script
  description      TEXT,                   -- nullable — human-readable note about this file
  appfolio_id      TEXT,                   -- nullable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Partial unique index + explicit constraint for Supabase upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_appfolio_id
  ON documents(appfolio_id)
  WHERE appfolio_id IS NOT NULL;

ALTER TABLE documents
  ADD CONSTRAINT documents_appfolio_id_unique UNIQUE (appfolio_id);

CREATE INDEX IF NOT EXISTS idx_documents_entity      ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_file_type   ON documents(file_type);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by) WHERE uploaded_by IS NOT NULL;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- VIEW: owner_summary
-- Replaces the stored owners.total_units column with a live
-- calculation derived from actual data.
--
-- Join path:
--   owners → property_owners (on appfolio_id text keys)
--   → properties (on appfolio_id)
--   → units (on property_id UUID)
--
-- property_owners uses appfolio_id text columns as join keys
-- (not UUID FKs) — this was by design so the sync can write
-- rows in any order. The view follows the same pattern.
--
-- property_count: distinct properties this owner holds.
-- total_units:    distinct unit records across all their properties.
--
-- Usage: SELECT total_units FROM owner_summary WHERE id = '<uuid>';
--        SELECT * FROM owner_summary ORDER BY total_units DESC;
-- ============================================================

CREATE OR REPLACE VIEW owner_summary AS
SELECT
  o.id,
  o.appfolio_id,
  o.name,
  o.phone,
  o.email,
  COUNT(DISTINCT p.id) AS property_count,
  COUNT(DISTINCT u.id) AS total_units
FROM owners o
LEFT JOIN property_owners po ON po.appfolio_owner_id    = o.appfolio_id
LEFT JOIN properties      p  ON p.appfolio_id           = po.appfolio_property_id
LEFT JOIN units           u  ON u.property_id           = p.id
GROUP BY o.id, o.appfolio_id, o.name, o.phone, o.email;


-- ============================================================
-- DROP owners.total_units
-- This column stored a running count that drifted out of sync
-- with reality whenever units were added or removed in AppFolio.
-- The owner_summary view above replaces it with a live calculation.
-- Any code that reads owners.total_units must be updated to query:
--   SELECT total_units FROM owner_summary WHERE id = '<owner_uuid>';
-- ============================================================

ALTER TABLE owners DROP COLUMN IF EXISTS total_units;


-- ============================================================
-- ROLLBACK (run in reverse order to undo this migration)
-- ============================================================
--
-- -- Restore total_units (data will be empty — repopulate from owner_summary)
-- ALTER TABLE owners ADD COLUMN IF NOT EXISTS total_units INTEGER;
--
-- DROP VIEW IF EXISTS owner_summary;
--
-- DROP TRIGGER IF EXISTS trg_documents_updated_at            ON documents;
-- DROP TRIGGER IF EXISTS trg_vendors_updated_at              ON vendors;
-- DROP TRIGGER IF EXISTS trg_contacts_updated_at             ON contacts;
-- DROP TRIGGER IF EXISTS trg_communications_log_updated_at   ON communications_log;
-- DROP TRIGGER IF EXISTS trg_scheduled_events_updated_at     ON scheduled_events;
-- DROP TRIGGER IF EXISTS trg_tasks_updated_at                ON tasks;
-- DROP TRIGGER IF EXISTS trg_workflow_instances_updated_at   ON workflow_instances;
-- DROP TRIGGER IF EXISTS trg_users_updated_at                ON users;
--
-- DROP INDEX IF EXISTS idx_documents_uploaded_by;
-- DROP INDEX IF EXISTS idx_documents_file_type;
-- DROP INDEX IF EXISTS idx_documents_entity;
-- DROP INDEX IF EXISTS idx_documents_appfolio_id;
-- DROP INDEX IF EXISTS idx_vendors_insurance_expiry;
-- DROP INDEX IF EXISTS idx_vendors_is_active;
-- DROP INDEX IF EXISTS idx_vendors_trade;
-- DROP INDEX IF EXISTS idx_vendors_appfolio_id;
-- DROP INDEX IF EXISTS idx_contacts_contact_type;
-- DROP INDEX IF EXISTS idx_contacts_related_tenant_id;
-- DROP INDEX IF EXISTS idx_contacts_related_unit_id;
-- DROP INDEX IF EXISTS idx_contacts_email;
-- DROP INDEX IF EXISTS idx_contacts_appfolio_id;
-- DROP INDEX IF EXISTS idx_audit_log_created_at;
-- DROP INDEX IF EXISTS idx_audit_log_action;
-- DROP INDEX IF EXISTS idx_audit_log_performed_by;
-- DROP INDEX IF EXISTS idx_audit_log_entity;
-- DROP INDEX IF EXISTS idx_communications_log_notice_type;
-- DROP INDEX IF EXISTS idx_communications_log_status;
-- DROP INDEX IF EXISTS idx_communications_log_sent_at;
-- DROP INDEX IF EXISTS idx_communications_log_workflow_instance_id;
-- DROP INDEX IF EXISTS idx_communications_log_entity;
-- DROP INDEX IF EXISTS idx_scheduled_events_workflow_instance_id;
-- DROP INDEX IF EXISTS idx_scheduled_events_entity;
-- DROP INDEX IF EXISTS idx_scheduled_events_pending;
-- DROP INDEX IF EXISTS idx_tasks_workflow_instance_id;
-- DROP INDEX IF EXISTS idx_tasks_entity;
-- DROP INDEX IF EXISTS idx_tasks_due_date;
-- DROP INDEX IF EXISTS idx_tasks_status;
-- DROP INDEX IF EXISTS idx_tasks_assigned_to;
-- DROP INDEX IF EXISTS idx_workflow_instances_created_by;
-- DROP INDEX IF EXISTS idx_workflow_instances_workflow_type;
-- DROP INDEX IF EXISTS idx_workflow_instances_status;
-- DROP INDEX IF EXISTS idx_workflow_instances_entity;
-- DROP INDEX IF EXISTS idx_users_email;
--
-- ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_appfolio_id_unique;
-- ALTER TABLE vendors   DROP CONSTRAINT IF EXISTS vendors_appfolio_id_unique;
-- ALTER TABLE contacts  DROP CONSTRAINT IF EXISTS contacts_appfolio_id_unique;
--
-- DROP TABLE IF EXISTS documents;
-- DROP TABLE IF EXISTS vendors;
-- DROP TABLE IF EXISTS contacts;
-- DROP TABLE IF EXISTS audit_log;
-- DROP TABLE IF EXISTS communications_log;
-- DROP TABLE IF EXISTS scheduled_events;
-- DROP TABLE IF EXISTS tasks;
-- DROP TABLE IF EXISTS workflow_instances;
-- DROP TABLE IF EXISTS users;
--
-- ============================================================
