-- 20260917000000_owner_instruction_note_text_is_now_factual_summary_only.sql
--
-- Documentation-only migration. No ALTER TABLE, no data change, no
-- behavior change — updates two column comments so the schema doesn't
-- describe a mechanism that no longer exists in the application code.
--
-- Peter's decision, Mason CLEARED (compliance/archive-search-significance-
-- complaint-merge-mason-review.md, "Follow-up to Finding 2", 2026-09-17):
-- Q (lib/significance-pass.js, buildCall2Prompt/runCall2Phase) stopped
-- generating both the live-mail fixed-template "Rincon's standard
-- refusal" response and the historical AI-drafted "Automated historical
-- assessment — not human verified" text. Neither column was ALTERed —
-- owner_instruction_note_text on both tables is reused as-is (Mason's
-- recommendation: reuse the existing slot rather than add a new column)
-- to hold nothing but owner_instruction_summary, the model's own short,
-- plain, FACTUAL paraphrase of the instruction — populated for BOTH
-- live and historical mail now (previously live-only, and previously
-- never persisted at all — it was only ever an ingredient string fed
-- into the now-deleted template function). owner_instruction_rejected
-- itself (true/false/uncertain) is completely unchanged and still routes
-- any true/uncertain result to a human, per the existing mechanism.
--
-- Optional to apply — this only corrects stale prose in `\d+` / psql
-- comment output. Nothing reads these comments at runtime.

COMMENT ON COLUMN complaints.owner_instruction_note_text IS
  'A plain, factual paraphrase of the owner''s instruction (owner_instruction_summary from Call 2), nothing more — never a drafted response, never an assessment of whether it''s discriminatory beyond owner_instruction_rejected itself. Populated for both live and historical mail. CHANGED 2026-09-17 (Peter''s decision, Mason CLEARED): previously held an AI-drafted response/assessment built from a fixed template; that template no longer exists. NULL when category != ''owner_instruction'' or the model returned no summary.';

COMMENT ON COLUMN missive_conversation_significance.owner_instruction_note_text IS
  'A plain, factual paraphrase of the owner''s instruction (owner_instruction_summary from Call 2), nothing more — never a drafted response, never an assessment of whether it''s discriminatory beyond owner_instruction_rejected itself. Populated for both live and historical mail (previously live-mail-only, and previously never persisted at all). CHANGED 2026-09-17 (Peter''s decision, Mason CLEARED — compliance/archive-search-significance-complaint-merge-mason-review.md, "Follow-up to Finding 2"): previously held an AI-drafted response (live mail, fixed template) or an AI-drafted historical assessment carrying the "Automated historical assessment — not human verified" label; neither is generated anymore. A human (Peter or the DO) reviews any owner_instruction_rejected = ''true''/''uncertain'' row via the existing "Needs a Human Call" / mandatory-clearance routing — unchanged by this column''s new, narrower meaning.';
