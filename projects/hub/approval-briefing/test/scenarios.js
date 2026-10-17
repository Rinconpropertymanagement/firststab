/**
 * test/scenarios.js
 *
 * Synthetic inputs for the byte-identical proof. Every scenario is a
 * property row plus a Latchel job object, invented for these tests. The
 * golden fixture (golden-emails.json) holds what the parent commit's
 * alert module (058618d, before the description block existed) produced
 * for each one; the new code in mode 'off' must reproduce it exactly.
 */

function baseProperty(over) {
  return Object.assign({
    id: 'prop-0001',
    name: '123 Test Street Unit A',
    address: '123 Test Street',
    pod: 'Solimar',
    latchel_property_id: '900001',
    maintenance_notes: 'Call the owner before any work over $500.',
  }, over);
}

function baseJob(over) {
  return Object.assign({
    job_id: 5001,
    property_id: 900001,
    order_number: 7001,
    created_at: '2026-10-01T15:30:00Z',
    updated_at: '2026-10-01T15:31:00Z',
    // Free-text fields that exist on a real Latchel job. The parent code
    // ignores them; the golden proves mode 'off' still does.
    name: 'Invented work order title',
    description: 'Invented description of the problem, for tests only.',
    is_emergency: false,
    is_urgent: false,
  }, over);
}

const SCENARIOS = [
  { name: 'normal-solimar', property: baseProperty(), job: baseJob() },
  {
    name: 'normal-faria',
    property: baseProperty({ id: 'prop-0002', name: '9 Sample Road', address: '9 Sample Road', pod: 'Faria', latchel_property_id: '900002' }),
    job: baseJob({ job_id: 5002, property_id: 900002, order_number: 7002 }),
  },
  {
    name: 'notes-with-quotes-newlines-unicode',
    property: baseProperty({ maintenance_notes: 'Owner said: "call first".\nSecond line with café — 你好 \u{1F6E0}\u{FE0F} and a tab\there.\n' }),
    job: baseJob({ job_id: 5003, order_number: 7003 }),
  },
  { name: 'missing-order-number', property: baseProperty(), job: baseJob({ job_id: 5004, order_number: undefined }) },
  { name: 'order-number-null', property: baseProperty(), job: baseJob({ job_id: 5005, order_number: null }) },
  {
    name: 'id-only-job',
    property: baseProperty(),
    job: (() => { const j = baseJob({ id: 5006, order_number: 7006 }); delete j.job_id; return j; })(),
  },
  { name: 'missing-created-at-uses-updated-at', property: baseProperty(), job: baseJob({ job_id: 5007, created_at: undefined }) },
  { name: 'missing-both-timestamps', property: baseProperty(), job: baseJob({ job_id: 5008, created_at: undefined, updated_at: undefined }) },
  {
    name: 'unassigned-pod-two-recipients',
    property: baseProperty({ id: 'prop-0003', pod: null, latchel_property_id: '900003' }),
    job: baseJob({ job_id: 5009, property_id: 900003, order_number: 7009 }),
  },
  {
    name: 'long-notes',
    property: baseProperty({ maintenance_notes: ('Long note sentence number one. ').repeat(120).trim() }),
    job: baseJob({ job_id: 5010, order_number: 7010 }),
  },
  {
    name: 'property-address-only',
    property: baseProperty({ name: null }),
    job: baseJob({ job_id: 5011, order_number: 7011 }),
  },
  {
    name: 'property-no-name-no-address',
    property: baseProperty({ name: null, address: null }),
    job: baseJob({ job_id: 5012, order_number: 7012 }),
  },
  {
    name: 'job-without-free-text-fields',
    property: baseProperty(),
    job: (() => { const j = baseJob({ job_id: 5013 }); delete j.name; delete j.description; delete j.is_emergency; delete j.is_urgent; return j; })(),
  },
];

module.exports = { SCENARIOS, baseProperty, baseJob };
