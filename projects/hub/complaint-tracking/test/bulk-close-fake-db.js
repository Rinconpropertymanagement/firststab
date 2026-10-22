'use strict';

/**
 * test/bulk-close-fake-db.js
 * An in-memory stand-in for the Supabase client, used only by
 * test/bulk-close-tests.js. Synthetic data only; touches no network.
 *
 * It behaves like the real service where the bulk close depends on it:
 *  - a select answers at most 1,000 rows, however much was asked for;
 *  - a request whose id list is too long for a web address is refused
 *    ("Bad Request"), which is what broke the list at ~1,000 ids once;
 *  - a column name that does not exist is refused, for selects, filters,
 *    updates and inserts, so a misspelt column cannot pass;
 *  - the database's own check rules are enforced: a resolved complaint needs
 *    a resolution note; an audit row needs a real actor type, risk level,
 *    privacy category and a UUID entity id;
 *  - an update stamps updated_at (the real table has a trigger that does);
 *  - there is NO delete: any attempt throws and is counted;
 *  - a NOT filter (not.is.null, not.in) works the way the database's does: a
 *    null never satisfies "not in".
 * Every call and every write is recorded so tests can look at exactly what
 * would have been sent and saved.
 */

const SCHEMA = {
  complaints: [
    'id', 'status', 'merged_into_id', 'held_legal_fair_housing', 'source', 'needs_human_call',
    'escalation_signal', 'severity_tier', 'flagged_protected_class', 'flagged_category', 'category',
    'owner_instruction_rejected', 'delegated_to_team_member_id', 'duplicate_status', 'possible_duplicate_of_id',
    'blocked_since', 'source_missive_conversation_id', 'property_id', 'updated_at', 'description', 'resolution_note',
  ],
  audit_log: [
    'id', 'action', 'entity_type', 'entity_id', 'performed_by', 'actor_type', 'actor_id',
    'privacy_category', 'risk_level', 'property_id', 'details', 'created_at', 'sequence_num',
  ],
  missive_message_intake: ['missive_conversation_id', 'delivered_at', 'subject', 'body_text', 'from_address'],
  team_members: ['id', 'full_name', 'email', 'is_active', 'auth_user_id'],
  users: ['id', 'email', 'alt_email'],
  team_member_tool_roles: ['team_member_id', 'tool', 'role'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = (v) => JSON.parse(JSON.stringify(v));

function compareValues(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta < tb ? -1 : 1;
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  return a === b ? 0 : (a < b ? -1 : 1);
}

function likeRegex(pattern, caseInsensitive) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, caseInsensitive ? 'is' : 's');
}

function parseOrTerm(term) {
  const parts = term.split('.');
  const col = parts[0];
  const op = parts[1];
  const raw = parts.slice(2).join('.');
  const val = raw === 'null' ? null : raw;
  return { col, op, val };
}

function matches(row, f) {
  const v = row[f.col];
  switch (f.kind) {
    case 'eq': return v === f.val || (typeof v === 'boolean' && typeof f.val === 'string' && String(v) === f.val);
    case 'neq': return v !== undefined && v !== null && v !== f.val && !(typeof v === 'boolean' && typeof f.val === 'string' && String(v) === f.val);
    case 'is': return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'in': return f.val.includes(v);
    case 'lte': return v !== undefined && v !== null && compareValues(v, f.val) <= 0;
    case 'gte': return v !== undefined && v !== null && compareValues(v, f.val) >= 0;
    case 'like': return typeof v === 'string' && likeRegex(f.val, false).test(v);
    case 'ilike': return typeof v === 'string' && likeRegex(f.val, true).test(v);
    case 'or': return f.terms.some((t) => matches(row, { kind: t.op, col: t.col, val: t.val }));
    case 'not': {
      // like the database: NOT (null LIKE x) and NOT (null IN x) are unknown, so the row is left out; only IS keeps its meaning
      if (f.op !== 'is' && (v === undefined || v === null)) return false;
      if (f.op === 'in') return !f.val.includes(v);
      return !matches(row, { kind: f.op, col: f.col, val: f.val });
    }
    default: throw new Error(`fake db: unsupported filter ${f.kind}`);
  }
}

function project(row, cols) {
  if (!cols || cols === '*') return clone(row);
  const out = {};
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (c in row) out[c] = clone(row[c]);
  }
  return out;
}

/**
 * seed: { complaints, audit, messages, members, users, roles }
 * hooks:
 *   before(call, state)  runs before a call executes; may change state.tables
 *                        (used to simulate someone else changing a row mid-way)
 *   fail(call, state)    return null, or { message, applied? }. With applied: true
 *                        the write IS saved but the answer is lost (an error is
 *                        returned anyway), the way a dropped connection behaves.
 *   delay(call)          milliseconds to wait before answering
 */
function makeDb(seed = {}, hooksIn = {}, { rowCap = 1000, idListLimit = 16000, startMs = Date.now() } = {}) {
  const hooks = hooksIn || {};
  const tables = {
    complaints: (seed.complaints || []).map(clone),
    audit_log: (seed.audit || []).map(clone),
    missive_message_intake: (seed.messages || []).map(clone),
    team_members: (seed.members || []).map(clone),
    users: (seed.users || []).map(clone),
    team_member_tool_roles: (seed.roles || []).map(clone),
  };
  const state = {
    calls: [], writes: [], deleteAttempts: 0, clock: startMs, tables,
    seq: tables.audit_log.reduce((m, r) => Math.max(m, r.sequence_num || 0), 0),
    nextAuditId: 1,
  };
  const tick = () => { state.clock += 1000; return new Date(state.clock).toISOString(); };

  function checkColumns(q) {
    const known = SCHEMA[q.table];
    const bad = [];
    const cols = (q.cols && q.cols !== '*' ? q.cols : '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const c of [...cols, ...(q.returning && q.returning !== '*' ? q.returning.split(',').map((s) => s.trim()) : [])]) if (!known.includes(c)) bad.push(c);
    for (const f of q.filters) {
      if (f.kind === 'or') { for (const t of f.terms) if (!known.includes(t.col)) bad.push(t.col); } else if (!known.includes(f.col)) bad.push(f.col);
    }
    for (const o of q.orders) if (!known.includes(o.col)) bad.push(o.col);
    if (q.patch) for (const k of Object.keys(q.patch)) if (!known.includes(k)) bad.push(k);
    if (q.rows) for (const r of q.rows) for (const k of Object.keys(r)) if (!known.includes(k)) bad.push(k);
    return bad.length ? `column ${[...new Set(bad)].join(', ')} of ${q.table} does not exist` : null;
  }

  function checkConstraints(table, row) {
    if (table === 'complaints') {
      if (row.status === 'resolved' && (row.resolution_note === null || row.resolution_note === undefined)) return 'violates check constraint "complaints_resolved_requires_note"';
      if (row.merged_into_id && row.duplicate_status !== 'confirmed_merged') return 'violates check constraint "complaints_merge_requires_confirmed"';
    }
    if (table === 'audit_log') {
      if (!row.action) return 'null value in column "action"';
      if (!row.entity_type) return 'null value in column "entity_type"';
      if (typeof row.entity_id !== 'string' || !UUID_RE.test(row.entity_id)) return 'invalid input syntax for type uuid: entity_id';
      if (row.performed_by !== null && row.performed_by !== undefined && !UUID_RE.test(row.performed_by)) return 'invalid input syntax for type uuid: performed_by';
      if (!['human', 'ai_agent', 'system'].includes(row.actor_type)) return 'violates check constraint "audit_log_actor_type_check"';
      if (!['collection', 'processing', 'dissemination', 'invasion', 'unclassified'].includes(row.privacy_category)) return 'violates check constraint "audit_log_privacy_category_check"';
      if (!['unclassified', 'low', 'medium', 'high', 'critical'].includes(row.risk_level)) return 'violates check constraint "audit_log_risk_level_check"';
    }
    return null;
  }

  async function execute(q, single) {
    const fail = (message, status = 400, code) => ({ data: null, error: code ? { message, code } : { message }, status, count: null });
    const bad = checkColumns(q);
    if (bad) return fail(bad);
    for (const f of q.filters) {
      if (f.kind === 'in' && f.val.join(',').length > idListLimit) return fail('Bad Request');
    }
    if (hooks.before) hooks.before(q, state);
    if (hooks.delay) { const ms = hooks.delay(q, state); if (ms) await new Promise((r) => setTimeout(r, ms)); }
    const failure = hooks.fail ? hooks.fail(q, state) : null;
    // hang: the call never answers (the process died, the connection froze).
    if (failure && failure.hang) { if (failure.before) failure.before(q, state); return new Promise(() => {}); }
    if (failure && !failure.applied) return fail(failure.message, 500, failure.code);

    let result;
    if (q.op === 'select') {
      let rows = tables[q.table].filter((r) => q.filters.every((f) => matches(r, f)));
      for (let i = q.orders.length - 1; i >= 0; i -= 1) {
        const o = q.orders[i];
        rows = rows.map((r, idx) => ({ r, idx })).sort((a, b) => (compareValues(a.r[o.col], b.r[o.col]) * (o.asc ? 1 : -1)) || (a.idx - b.idx)).map((x) => x.r);
      }
      const total = rows.length;
      if (q.range) rows = rows.slice(q.range[0], Math.min(q.range[1], q.range[0] + rowCap - 1) + 1);
      else rows = rows.slice(0, rowCap);
      if (q.limit !== null) rows = rows.slice(0, q.limit);
      if (q.head) {
        result = { data: null, error: null, status: 200, count: total };
      } else {
        const data = rows.map((r) => project(r, q.cols));
        if (single === 'maybe') {
          result = data.length > 1 ? fail('multiple rows returned', 406) : { data: data[0] || null, error: null, status: 200, count: null };
        } else if (single === 'single') {
          result = data.length === 1 ? { data: data[0], error: null, status: 200, count: null } : fail('no single row', 406);
        } else {
          result = { data, error: null, status: 200, count: q.count ? total : null };
        }
      }
    } else if (q.op === 'update') {
      const targets = tables[q.table].filter((r) => q.filters.every((f) => matches(r, f)));
      const updated = targets.map((r) => ({ ...r, ...clone(q.patch), ...(SCHEMA[q.table].includes('updated_at') ? { updated_at: tick() } : {}) }));
      const violation = updated.map((r) => checkConstraints(q.table, r)).find(Boolean);
      if (violation) return fail(violation);
      targets.forEach((r, i) => Object.assign(r, updated[i]));
      state.writes.push({ table: q.table, op: 'update', ids: targets.map((r) => r.id), patch: clone(q.patch), filters: clone(q.filters) });
      result = { data: q.returning ? updated.map((r) => project(r, q.returning)) : null, error: null, status: 200, count: null };
    } else if (q.op === 'insert') {
      const made = q.rows.map((r) => {
        const row = clone(r);
        if (q.table === 'audit_log') {
          row.id = row.id || `aaaaaaaa-0000-4000-8000-${String(state.nextAuditId++).padStart(12, '0')}`;
          row.created_at = tick();
          state.seq += 1;
          row.sequence_num = state.seq;
        }
        return row;
      });
      const violation = made.map((r) => checkConstraints(q.table, r)).find(Boolean);
      if (violation) return fail(violation);
      tables[q.table].push(...made);
      state.writes.push({ table: q.table, op: 'insert', rows: clone(q.rows) }); // what was SENT, before the database adds ids and times
      result = { data: q.returning ? made.map((r) => project(r, q.returning)) : null, error: null, status: 201, count: null };
    } else {
      return fail(`fake db: unsupported operation ${q.op}`);
    }
    if (failure && failure.applied) return fail(failure.message, 500, failure.code);
    return result;
  }

  function from(table) {
    if (!tables[table]) throw new Error(`fake db: unknown table ${table}`);
    const q = {
      table, op: 'select', cols: '*', returning: null, filters: [], orders: [], range: null, limit: null,
      patch: null, rows: null, count: null, head: false,
    };
    state.calls.push(q);
    const chain = {
      select(cols, o) {
        if (q.op === 'select') q.cols = cols || '*'; else q.returning = cols || '*';
        if (o && o.count) { q.count = o.count; q.head = !!o.head; }
        return chain;
      },
      insert(rows) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return chain; },
      update(patch) { q.op = 'update'; q.patch = patch; return chain; },
      delete() { state.deleteAttempts += 1; throw new Error('fake db: DELETE is never allowed in the bulk close'); },
      upsert() { throw new Error('fake db: upsert is not used'); },
      eq(col, val) { q.filters.push({ kind: 'eq', col, val }); return chain; },
      neq(col, val) { q.filters.push({ kind: 'neq', col, val }); return chain; },
      is(col, val) { q.filters.push({ kind: 'is', col, val }); return chain; },
      in(col, val) { q.filters.push({ kind: 'in', col, val }); return chain; },
      not(col, op, val) {
        let parsed = val;
        if (op === 'in') parsed = String(val).replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
        else if (op === 'is' && (val === null || val === 'null')) parsed = null;
        q.filters.push({ kind: 'not', op, col, val: parsed });
        return chain;
      },
      lte(col, val) { q.filters.push({ kind: 'lte', col, val }); return chain; },
      gte(col, val) { q.filters.push({ kind: 'gte', col, val }); return chain; },
      like(col, val) { q.filters.push({ kind: 'like', col, val }); return chain; },
      ilike(col, val) { q.filters.push({ kind: 'ilike', col, val }); return chain; },
      or(str) { q.filters.push({ kind: 'or', terms: str.split(',').map(parseOrTerm) }); return chain; },
      order(col, o) { q.orders.push({ col, asc: !(o && o.ascending === false) }); return chain; },
      range(a, b) { q.range = [a, b]; return chain; },
      limit(n) { q.limit = n; return chain; },
      maybeSingle() { return execute(q, 'maybe'); },
      single() { return execute(q, 'single'); },
      then(resolve, reject) { return execute(q, null).then(resolve, reject); },
    };
    return chain;
  }

  const writesTo = (table, op) => state.writes.filter((w) => w.table === table && (!op || w.op === op));
  return { client: { from }, state, tables, writesTo, tick };
}

module.exports = { makeDb, SCHEMA };
