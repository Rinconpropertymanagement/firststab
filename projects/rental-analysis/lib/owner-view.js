/**
 * lib/owner-view.js
 * The "Owner view (one page)": the short, printable rent opinion that staff save as a PDF
 * and attach to their OWN email to a property owner.
 *
 * Everything the owner reads is built HERE, by code, from the saved report:
 *   - fixed template sentences (typed once, below)
 *   - numbers and dates worked out from the saved report (the range, the suggested price,
 *     the six homes in the table, the counts, the analysis date)
 * Nothing on the page is written by the AI, and nothing is a staff note. The screen
 * (dashboard/index.html) only formats the object this file returns; it never decides
 * anything. The same object is built for a report that has just been run (lib/outcome.js)
 * and for a saved report that is reopened (lib/history.js), so the two always agree.
 *
 * What is NOT in the object at all (not hidden, absent): the stretch price, the middle of
 * the comps, the accuracy figures, the written explanation, condition grades, where each
 * home came from, why a home was or was not counted, distances, ids, tags of any kind.
 * Each table row carries exactly seven things: street (and unit), type, bedrooms, baths,
 * square feet, status with month, rent.
 *
 * This tool never sends anything. There is no email, text, share link, schedule or web
 * address here, and none may be added without a new legal and governance review.
 *
 * Nothing here talks to the network or the database, and nothing reads the clock: the date
 * on the page is the day the analysis was run, never today's date.
 */

const { RADIUS_LADDER_MILES, HEADLINE_RANGE_WIDTH, HEADLINE_MIN_COMPS } = require('./constants');
const { normalizeOwnerGoal } = require('./weighting');
const { isSameHome } = require('./property-matching');

// Change this whenever the wording, the layout rules or the row rules change. Git is the change log.
const OWNER_VIEW_TEMPLATE_VERSION = 'owner-2026-10-v1';

// ─── Who the page is from (one place for each fact) ──────────────────────────
const COMPANY_NAME = 'Rincon Property Management';
const WORDMARK = 'RINCON PROPERTY MANAGEMENT'; // stands in for the logo until the logo file is supplied
const DRE_LICENSE = '01951188';
const OFFICE_ADDRESS = '1500 Palma Drive, Suite 280, Ventura, CA 93003'; // the ONE copy of the office address
const OFFICE_PHONE = '805.288.1119';
const OFFICE_EMAIL = 'info@rinconmanagement.com';

// The company is in California; the date on the page is the calendar day there.
const PAGE_TIME_ZONE = 'America/Los_Angeles';

// ─── The rules for the table ─────────────────────────────────────────────────
const MAX_TABLE_ROWS = 6;
const MIN_TABLE_ROWS = HEADLINE_MIN_COMPS; // fewer printable homes than this and there is no page
const MAX_LEASED_ROWS_BEFORE_ACTIVE = 5;   // one slot is kept for the best active listing
// A home whose rent is more than this share away from the middle of the comps is left off the page.
const OUTLIER_SHARE = 0.25;
// Homes with any of these tags are not like the owner's home in a way a reader would see; they stay in the
// math (unless excluded elsewhere) but are left off the page.
const LEFT_OFF_FLAGS = ['utilities_included', 'adu_or_guest_house', 'partly_furnished', 'new_construction'];
const DAYS_PER_MONTH = 30.4375;

// ─── Fixed wording ───────────────────────────────────────────────────────────
const TEXT = {
  title: 'RENTAL COMPARATIVE MARKET ANALYSIS',
  asOfPrefix: 'Market data as of: ',
  introAfter: ' We compared your home to similar homes nearby that have leased or have been listed for rent.',
  factsAfter: ' If any of these details are wrong, please tell us, because they can change the result.',
  rangeBefore: 'Based on the comparable homes we located, we recommend an asking rent of ',
  rangeAfter: ' per month for your home. This is our professional opinion, not a guarantee of the rent a tenant will pay.',
  lowRangeBefore: 'Based on the comparable homes we located, a starting point for your asking rent is ',
  lowRangeAfter: ' per month. We found few comparable homes, or their rents differ widely, so this is a starting point only. We recommend a walkthrough of your home before the rent is finalized.',
  agreementLead: 'How closely the comparable homes agree: ',
  agreementAfter: '. This describes how similar the comparable rents are to one another; it is not a prediction of the rent a tenant will pay.',
  goalBefore: {
    lease_quickly: 'If your goal is leasing quickly, we suggest listing at ',
    balanced: 'If you prefer a balanced approach, we suggest listing at ',
    maximize_rent: 'If your goal is maximizing rent, we suggest listing at ',
  },
  goalAfter: '.',
  ends: 'The lower end of the range is for owners who want to lease quickly. The upper end is for owners willing to wait for a higher rent, which may mean the home sits vacant longer.',
  tableHeads: ['Property Address', 'Type', 'BR', 'BA', 'Sq. Ft.', 'Status', 'Amount'],
  key: 'Leased = rent the tenant agreed to pay. Active = currently listed; the amount is the asking rent, not a leased rent. Off market = was listed and later removed; we could not confirm it leased, and the amount is the last asking rent.',
  disclaimer: `This analysis is ${COMPANY_NAME}'s opinion of a reasonable asking rent, based on the information shown and on information from third-party sources that we believe to be reliable but have not verified. It is not an appraisal and should not be used as one, or for lending, tax or insurance purposes. It is not a guarantee of the rent a tenant will pay or of how long the home will take to lease. It reflects market data as of the date above and does not account for the condition of your home or for any rent limits, program rules or emergency orders that may apply to it. Market conditions change.`,
};
const LEVEL_WORDS = { high: 'Strong', medium: 'Moderate' };

// The footer, exactly as Peter gave it.
const FOOTER_LINES = [
  `${COMPANY_NAME} | DRE License # ${DRE_LICENSE}`,
  OFFICE_ADDRESS,
  `${OFFICE_PHONE} | ${OFFICE_EMAIL}`,
];

// Why there is no owner view, in words the screen can show as they are.
const NOTES = {
  noRange: 'The owner view is not available because this report has no recommended range.',
  noLabel: 'The owner view is not available because this report has no saved confidence level.',
  noDate: 'The owner view is not available because this report has no saved analysis date.',
  noFacts: 'The owner view is not available because the home details saved with this report are incomplete.',
  noMiddle: 'The owner view is not available because a figure needed to choose the homes to print is missing from this report.',
  badRange: 'The owner view is not available because the saved range could not be shown.',
  countsMismatch: 'The owner view is not available because the comparable homes on this saved report no longer match the counts saved with it.',
  wording: 'The owner view is not available because the page did not pass its wording check.',
  error: 'The owner view could not be built for this report.',
  older: 'The owner view is not available for reports run with the previous method. Run the analysis again.',
  unfinished: 'The owner view is not available because this report did not finish.',
};
const notEnoughRows = n => `The owner view is not available: only ${n} comparable ${n === 1 ? 'home' : 'homes'} can be shown on the one-page owner view, and at least ${MIN_TABLE_ROWS} are needed.`;

// ─── Small helpers ───────────────────────────────────────────────────────────
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plain = v => (typeof v === 'string' ? v.trim() : '');

function money(n) {
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}

// The database keeps baths to one decimal, so 1.75 comes back as 1.8 and 1.25 as 1.3. Baths come in quarters, so those two
// endings are put back; a half stays a half.
function bathText(n) {
  const v = Number(n);
  if (Number.isInteger(v)) return String(v);
  const t = v.toFixed(1);
  if (t.endsWith('.8')) return `${t.slice(0, -2)}.75`;
  if (t.endsWith('.3')) return `${t.slice(0, -2)}.25`;
  return t;
}

// 'YYYY-MM-DD' (or a longer ISO text starting with one) -> whole days since 1970, or null when it is not a real date.
function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

// "9/2026" from a 'YYYY-MM-DD' date.
function monthYear(iso) {
  return dayNumber(iso) === null ? null : `${Number(iso.slice(5, 7))}/${iso.slice(0, 4)}`;
}

/**
 * The day the analysis was run, as the calendar day in California: { iso: '2026-10-16', text: 'October 16, 2026' }.
 * null when the report has no usable saved date. Today's date is NEVER used instead: a reopened report can be old.
 */
function analysisDate(createdAt) {
  if (createdAt === null || createdAt === undefined || createdAt === '') return null;
  const when = new Date(createdAt);
  if (Number.isNaN(when.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(when).map(p => [p.type, p.value]));
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    text: new Intl.DateTimeFormat('en-US', { timeZone: PAGE_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric' }).format(when),
  };
}

// ─── Addresses ───────────────────────────────────────────────────────────────
const COUNTRY_RE = /^(?:USA|US|United States(?: of America)?)$/i;
const STATE_ZIP_RE = /^(?:[A-Za-z]{2}|California)(?:\s+\d{5}(?:-\d{4})?)?$/i;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
// A state and/or zip typed on the end of the city part ("Santa Paula CA 93060"). Only CA / California, or any two letters
// followed by a zip, or a bare zip, so a city that merely ends in a short word is left alone.
const CITY_TAIL_RE = /\s+(?:(?:CA|California)(?:\s+\d{5}(?:-\d{4})?)?|[A-Za-z]{2}\s+\d{5}(?:-\d{4})?|\d{5}(?:-\d{4})?)$/i;
// A unit is a keyword, then a separator (a space, a dot or a #), then a short unit name: a number, one to three letters, or a
// position word ("Unit 5", "Apt. B", "Unit ADU", "Unit Rear", "Unit Studio", "Suite 280", "#12"). A city such as "Lotus", "Stewart", "Floral" or "Space City" is not a unit.
const UNIT_RE = /^(?:(?:apt|apartment|unit|suite|ste|spc|space|lot|bldg|building|fl|floor)(?:\.\s*|\s+|\s*#\s*)(?:[A-Za-z]{1,3}|[\w-]*\d[\w-]*|rear|front|back|upper|lower|garage|studio)|#\s*[\w-]+)$/i;

/**
 * "2461 Bunting Avenue, Ventura, CA 93003" -> { street: "2461 Bunting Avenue", city: "Ventura" }.
 * A unit written as its own part ("123 Main St, Unit 5, Ventura, CA") is kept with the street. With nothing to
 * tell a city apart (no commas), the whole text is the street and the city is null: nothing is guessed.
 */
function splitAddress(address) {
  const parts = plain(address).split(',').map(p => p.trim()).filter(Boolean);
  while (parts.length > 1 && COUNTRY_RE.test(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && (STATE_ZIP_RE.test(parts[parts.length - 1]) || ZIP_RE.test(parts[parts.length - 1]))) parts.pop();
  if (!parts.length) return { street: '', city: null };
  let street = parts[0];
  let i = 1;
  while (i < parts.length && UNIT_RE.test(parts[i])) street += ` ${parts[i++]}`;
  const city = i < parts.length ? parts[parts.length - 1].replace(CITY_TAIL_RE, '').trim() : '';
  return { street, city: city || null };
}

// ─── Property type words ─────────────────────────────────────────────────────
const TYPE_COLUMN = {
  single_family: 'SFR', townhouse: 'Townhome', condo: 'Condo', duplex: 'Duplex', triplex: 'Triplex',
  fourplex: 'Fourplex', apartment: 'Apt', manufactured: 'Mfd. Home', other: 'Other',
};
const TYPE_SENTENCE = {
  single_family: 'single family home', townhouse: 'townhouse', condo: 'condo', duplex: 'duplex', triplex: 'triplex',
  fourplex: 'fourplex', apartment: 'apartment', manufactured: 'manufactured home', other: 'home',
};

// ─── Which homes can be printed, and which six ───────────────────────────────
const STATUS_ORDER = ['leased', 'active', 'off_market'];

function dateOfComp(c) {
  // a lease is dated by its lease date, an active listing by the day it was listed, and an off-market one by
  // the day it was listed (the removal date is kept apart: it is only used for the label)
  if (c.listing_status === 'leased') return plain(c.leased_date) || null;
  return plain(c.listed_date) || plain(c.leased_date) || null;
}

/**
 * The counted homes that may appear in the table. A home is left out when it is not counted, has no rent, a lease
 * with no real date (or a date after the analysis day), or carries one of the tags that make it unlike the
 * owner's home, or when its rent is more than OUTLIER_SHARE away from `midpoint` (the middle of the counted comps,
 * which is never printed; without a usable one nothing is printable). A home that is not counted never gets here, whatever else is true of it.
 */
function printableComps(comps, { midpoint, analysisDay, subjectAddress = null }) {
  // with no usable middle nothing can be judged, so nothing is printable (buildOwnerView() says so in plain words)
  if (num(midpoint) === null || midpoint <= 0) return [];
  return (Array.isArray(comps) ? comps : []).filter(c => {
    if (!c || c.exclusion_reason) return false;
    // The owner's own home never appears as one of its own comparable homes. It can still be a counted comp (its own earlier
    // lease is evidence for a re-lease), so it stays in the math and in the count, but it is never a printed row.
    if (subjectAddress && isSameHome(subjectAddress, c.address)) return false;
    if (!STATUS_ORDER.includes(c.listing_status)) return false;
    const rent = num(Number(c.monthly_rent));
    if (rent === null || rent <= 0) return false;
    if (c.listing_status === 'leased') {
      const day = dayNumber(c.leased_date);
      if (day === null || day > analysisDay) return false;
    } else if (c.listing_status === 'active' && plain(c.listed_date)) {
      const day = dayNumber(c.listed_date);
      if (day === null || day > analysisDay) return false;
    }
    if (Array.isArray(c.mls_flags) && c.mls_flags.some(f => LEFT_OFF_FLAGS.includes(f))) return false;
    if (Math.abs(rent - midpoint) > OUTLIER_SHARE * midpoint) return false;
    return true;
  });
}

const sameName = (a, b) => {
  const clean = s => plain(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean(a) !== '' && clean(a) === clean(b);
};

// The order within one status: same community first (when both are known), then nearest, then closest in size,
// then newest. Every tie is broken the same way every time, so a report and the same report reopened agree.
function rankComparator(subjectSqft, subjectSubdivision) {
  const missingLast = (x, y) => (x === null && y === null ? 0 : x === null ? 1 : y === null ? -1 : x - y);
  return (a, b) => {
    const ca = sameName(a.subdivision_name, subjectSubdivision) ? 0 : 1;
    const cb = sameName(b.subdivision_name, subjectSubdivision) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const d = missingLast(num(a.distance_miles), num(b.distance_miles));
    if (d) return d;
    if (num(subjectSqft) !== null) {
      const sa = num(a.sqft) !== null && a.sqft > 0 ? Math.abs(a.sqft - subjectSqft) : null;
      const sb = num(b.sqft) !== null && b.sqft > 0 ? Math.abs(b.sqft - subjectSqft) : null;
      const s = missingLast(sa, sb);
      if (s) return s;
    }
    const da = dayNumber(dateOfComp(a)), db = dayNumber(dateOfComp(b));
    const n = missingLast(da === null ? null : -da, db === null ? null : -db);
    if (n) return n;
    return String(a.address || '').localeCompare(String(b.address || ''))
      || (Number(a.monthly_rent) - Number(b.monthly_rent))
      || String(a.id || '').localeCompare(String(b.id || ''));
  };
}

/**
 * Picks up to six homes: the best leased homes (up to five, so one place is kept), the best active listing, then
 * more leased homes and more active listings to fill the six, and off-market homes ONLY to get to the minimum of
 * four. Shown in this order: leased, active, off market.
 */
function selectRows(printable, { subjectSqft = null, subjectSubdivision = null } = {}) {
  const rank = rankComparator(subjectSqft, subjectSubdivision);
  const by = status => printable.filter(c => c.listing_status === status).sort(rank);
  const leased = by('leased'), active = by('active'), offMarket = by('off_market');
  const picked = [];
  picked.push(...leased.slice(0, active.length ? MAX_LEASED_ROWS_BEFORE_ACTIVE : MAX_TABLE_ROWS));
  if (active.length) picked.push(active[0]);
  for (const c of [...leased.slice(MAX_LEASED_ROWS_BEFORE_ACTIVE), ...active.slice(1)]) {
    if (picked.length >= MAX_TABLE_ROWS) break;
    picked.push(c);
  }
  for (const c of offMarket) {
    if (picked.length >= MIN_TABLE_ROWS) break;
    picked.push(c);
  }
  const order = status => STATUS_ORDER.indexOf(status);
  return picked.map((c, i) => ({ c, i })).sort((x, y) => order(x.c.listing_status) - order(y.c.listing_status) || x.i - y.i).map(x => x.c);
}

// ─── One row of the table (the whitelist: seven things, nothing else) ────────
/**
 * @returns {{address: string, type: string, beds: string, baths: string, sqft: string, status: string, rent: string}}
 */
function shapeRow(c, { analysisDay }) {
  const status = c.listing_status;
  let statusText, rentSuffix;
  if (status === 'leased') {
    // Only a confirmed lease is ever called Leased, and only from its lease date.
    statusText = `Leased ${monthYear(c.leased_date)}`;
    rentSuffix = 'leased';
  } else if (status === 'active') {
    // Days are counted to the day the analysis was run, not to the day the page is opened. A home listed that same day says "newly
    // listed" (true whenever the page is opened) rather than "0 days" or "today".
    const listed = dayNumber(c.listed_date);
    const days = listed === null ? null : Math.max(0, analysisDay - listed);
    statusText = days === null ? 'Active' : days === 0 ? 'Active, newly listed' : `Active ${days} ${days === 1 ? 'day' : 'days'}`;
    rentSuffix = 'asking';
  } else {
    // An off-market home is never called Leased: the listing came down and nobody confirmed a lease. The date
    // saved for it is the day the listing was removed.
    const removed = monthYear(plain(c.leased_date));
    statusText = removed ? `Off market ${removed}` : 'Off market';
    rentSuffix = 'last asking';
  }
  const beds = num(c.bedrooms), baths = num(c.bathrooms), sqft = num(c.sqft);
  return {
    address: splitAddress(c.address).street || '-',
    type: TYPE_COLUMN[c.property_type] || '-',
    beds: beds === null ? '-' : String(beds),
    baths: baths === null ? '-' : bathText(baths),
    sqft: sqft === null || sqft <= 0 ? '-' : sqft.toLocaleString('en-US'),
    status: statusText,
    rent: `${money(c.monthly_rent)}/mo ${rentSuffix}`,
  };
}

// ─── The sentences built from the data ───────────────────────────────────────
const NUMBER_WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

/** "$4,200 - $4,400" */
const rangeText = (low, high) => `${money(low)} - ${money(high)}`;

function goalSentence(goal, listPrice) {
  const g = normalizeOwnerGoal(goal);
  return `${TEXT.goalBefore[g]}${money(listPrice)}${TEXT.goalAfter}`;
}

// The smallest search ring (from the ring list the search itself uses) that holds every counted home, or null when
// any counted home has no measured distance (then "within X miles" cannot be said for all of them).
function ringMiles(counted) {
  if (!counted.length) return null;
  const miles = counted.map(c => num(c.distance_miles));
  if (miles.some(m => m === null)) return null;
  const farthest = Math.max(...miles);
  const ring = RADIUS_LADDER_MILES.find(r => farthest <= r + 1e-9);
  return ring !== undefined ? ring : Math.ceil(farthest * 2) / 2;
}

// Whole months back to the oldest counted home, rounded up, never less than one. null when ANY counted home has no usable
// date: the claim "all of them are from the last N months" cannot be made for a home whose date is not known.
function monthsBack(counted, analysisDay) {
  const days = counted.map(c => dayNumber(dateOfComp(c)));
  if (!days.length || days.some(d => d === null)) return null;
  return Math.max(1, Math.ceil(Math.max(0, analysisDay - Math.min(...days)) / DAYS_PER_MONTH - 1e-9));
}

/**
 * The sentence under the table, worked out from the counted homes and the rows shown. Nothing in it is typed in.
 * @param {object[]} counted - every counted home (not only the ones in the table)
 * @param {number} shown - how many rows are in the table
 */
function countSentence(counted, shown, analysisDay) {
  const n = counted.length;
  if (n === 0) return 'This analysis found no comparable homes.';
  const miles = ringMiles(counted);
  const where = miles === null ? 'nearby' : `within ${miles} ${miles === 1 ? 'mile' : 'miles'} of your home`;
  const months = monthsBack(counted, analysisDay);
  const when = months === null ? '' : ` in roughly the last ${months === 1 ? 'month' : `${months} months`}`;
  const used = `This analysis uses ${n} comparable ${n === 1 ? 'home' : 'homes'} ${where} that leased or were listed for rent${when}.`;
  let how;
  if (shown === 0) how = n === 1 ? 'That home is not shown.' : 'None of them are shown.';
  else if (shown === n) how = n === 1 ? 'That home is shown.' : n === 2 ? 'Both are shown.' : `All ${n} are shown.`;
  else how = `${capital(NUMBER_WORDS[shown] || String(shown))} of the ${n} comparable homes ${shown === 1 ? 'is' : 'are'} shown.`;
  return `${used} ${how}`;
}

function factsSentence(analysis) {
  const beds = analysis.subject_bedrooms, baths = analysis.subject_bathrooms, sqft = analysis.subject_sqft;
  const bedText = beds === 0 ? 'studio' : `${beds} bedroom`;
  const article = beds === 0 ? 'a' : (/^(?:8|11|18)$/.test(String(beds)) ? 'an' : 'a');
  const type = TYPE_SENTENCE[analysis.subject_property_type] || 'home';
  const size = num(sqft) !== null && sqft > 0 ? ` of ${Math.round(sqft).toLocaleString('en-US')} square feet` : '';
  return `Our records show your home as ${article} ${bedText}, ${bathText(baths)} bath ${type}${size}.${TEXT.factsAfter}`;
}

// ─── The wording check ───────────────────────────────────────────────────────
// Words and phrases the page must never contain (Fair Housing). Whole words only, any capitals.
const FORBIDDEN_WORDS = [
  'families', 'child', 'children', 'kid', 'kids', 'school', 'schools', 'adult', 'adults', 'senior', 'seniors',
  'retire', 'retiree', 'young', 'professionals', 'couple', 'couples', 'singles', 'bachelor', 'safe', 'safety',
  'crime', 'quiet', 'desirable', 'exclusive', 'prestigious', 'walkable', 'church', 'voucher', '55',
];
const FORBIDDEN_PHRASES = [
  'empty nest', 'section 8', '55+', 'age-restricted', 'managed by', 'rincon-managed',
  // the company's own "language to avoid" list, word for word
  'perfect for a single professional', 'adult community', 'no children', 'empty nesters', 'mature tenant only',
  'christian home', 'english speakers only', 'able-bodied', 'must be able to climb stairs',
  'not suitable for wheelchairs', 'no emotional-support animals', 'ideal for a bachelor', 'great for a single woman',
  'no section 8', 'no vouchers',
];
// Promises and numbers this page must never carry.
const FORBIDDEN_PAGE_PHRASES = ['will rent', 'will lease', 'stretch', 'midpoint', 'window'];
// Fixed template phrases that look like a forbidden word to a plain scan but are not used that way.
const ALLOWED_PHRASES = ['professional opinion', 'walkthrough', 'condition of your home'];
// "family" is only allowed inside these property-type names.
const FAMILY_COMPOUNDS = ['single family', 'single-family', 'multi-family', 'multifamily'];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeRe = w => new RegExp(`(?<![A-Za-z0-9])${escapeRe(w)}(?![A-Za-z0-9])`, 'i');
const FORBIDDEN_RES = [...FORBIDDEN_WORDS, ...FORBIDDEN_PHRASES].map(w => [w, wholeRe(w)]);
const PAGE_PHRASE_RES = FORBIDDEN_PAGE_PHRASES.map(w => [w, wholeRe(w)]);

/**
 * The forbidden words and phrases found in `text` (an empty list is the good answer). The three template phrases
 * in ALLOWED_PHRASES are taken out first; "family" is allowed only inside a property-type name.
 */
function findForbiddenTerms(text, { includePagePhrases = false } = {}) {
  let t = String(text || '');
  for (const p of ALLOWED_PHRASES) t = t.replace(new RegExp(escapeRe(p), 'gi'), ' ');
  for (const p of FAMILY_COMPOUNDS) t = t.replace(new RegExp(escapeRe(p), 'gi'), ' ');
  const hits = FORBIDDEN_RES.filter(([, re]) => re.test(t)).map(([w]) => w);
  if (wholeRe('family').test(t)) hits.push('family');
  if (includePagePhrases) hits.push(...PAGE_PHRASE_RES.filter(([, re]) => re.test(t)).map(([w]) => w));
  return hits;
}

// Digits are masked before the word scan: a computed number ("Active 55 days", "uses 55 comparable homes") is not
// text about a community. The fixed sentences are ALSO scanned unmasked, so a typed "55" or "55+" is still caught.
const maskNumbers = s => String(s).replace(/\d[\d,]*(?:\.\d+)?/g, '#');
const flatten = (parts, { addresses = false } = {}) => (Array.isArray(parts) ? parts.filter(p => !(addresses ? !p.address : p.address)).map(p => p.text).join('') : '');

/**
 * Every piece of text on the page, in two lists: the fixed and computed sentences, and the street addresses (a real
 * street can be called "Church Street", so addresses are checked on their own and never block the page).
 */
function ownerViewStrings(view) {
  const rows = view.table.rows;
  const addresses = [flatten(view.intro, { addresses: true }), ...rows.map(r => r.address)].filter(Boolean);
  const template = [
    view.title, view.asOfLine, view.brand.wordmark, view.brand.dre,
    flatten(view.intro), flatten(view.facts), flatten(view.range), flatten(view.agreement), flatten(view.goal), flatten(view.ends),
    ...view.table.heads,
    ...rows.flatMap(r => [r.type, r.beds, r.baths, r.sqft, r.status, r.rent]),
    view.key, view.countLine, view.disclaimer, ...view.footer,
  ].filter(Boolean);
  return { template, addresses };
}

// Every typed-in piece of wording, before any number or address is put into it.
function fixedWording() {
  const t = TEXT;
  return [
    t.title, t.asOfPrefix, t.introAfter, t.factsAfter, t.rangeBefore, t.rangeAfter, t.lowRangeBefore, t.lowRangeAfter,
    t.agreementLead, t.agreementAfter, ...Object.values(t.goalBefore), t.goalAfter, t.ends, ...t.tableHeads, t.key, t.disclaimer,
    ...Object.values(LEVEL_WORDS), ...Object.values(TYPE_COLUMN), ...FOOTER_LINES, WORDMARK,
  ];
}

// The dollar figures in a piece of text.
function dollarFigures(text) {
  return (String(text).match(/\$[\d,]+/g) || []);
}

/**
 * The checks the finished page must pass. Returns a list of problems (empty = fine).
 * @param {object} view
 * @param {{rangeLow: number, rangeHigh: number, listPrice: number|null}} allowed
 */
function selfCheck(view, allowed) {
  const problems = [];
  const { template } = ownerViewStrings(view);
  const fixedHits = findForbiddenTerms(fixedWording().join('\n'), { includePagePhrases: true });
  const pageHits = findForbiddenTerms(maskNumbers(template.join('\n')), { includePagePhrases: true });
  const hits = [...new Set([...fixedHits, ...pageHits])];
  if (hits.length) problems.push(`forbidden wording: ${hits.join(', ')}`);
  const ok = new Set([money(allowed.rangeLow), money(allowed.rangeHigh)]);
  if (allowed.listPrice !== null) ok.add(money(allowed.listPrice));
  for (const row of view.table.rows) ok.add(row.rent.split('/')[0]);
  const stray = dollarFigures(template.join('\n')).filter(f => !ok.has(f));
  if (stray.length) problems.push(`unexpected dollar figures: ${stray.join(', ')}`);
  const n = view.table.rows.length;
  if (n < MIN_TABLE_ROWS || n > MAX_TABLE_ROWS) problems.push(`table has ${n} rows`);
  return problems;
}

// ─── The whole page ──────────────────────────────────────────────────────────
const seg = (text, bold = false, address = false) => ({ text, ...(bold ? { bold: true } : {}), ...(address ? { address: true } : {}) });

/**
 * Builds the owner view from a report's saved data.
 * @param {object} input
 * @param {object} input.analysis - the saved analysis row (created_at and the subject's details are used)
 * @param {object[]} input.comps - the report's comps, each with exclusion_reason (null when it counted)
 * @param {{low: number, high: number, listPrice: number, goal: string}|null} input.headline - the recommended range
 * @param {'high'|'medium'|'low'|null} input.confidenceLabel
 * @param {number|null} input.midpoint - the internal middle of the counted comps (used only to leave outliers off)
 * @param {number} [input.countedTotal] - how many comps counted, as the report says (must equal the recount)
 * @returns {{ownerView: object|null, ownerViewNote: string|null}} exactly one of the two is null
 */
function buildOwnerView({ analysis, comps, headline, confidenceLabel, midpoint = null, countedTotal } = {}) {
  const no = note => ({ ownerView: null, ownerViewNote: note });
  const a = analysis || {};
  if (!headline) return no(NOTES.noRange);
  const label = ['high', 'medium', 'low'].includes(confidenceLabel) ? confidenceLabel : null;
  if (!label) return no(NOTES.noLabel);
  if (!(num(headline.low) !== null && num(headline.high) !== null && headline.high - headline.low === HEADLINE_RANGE_WIDTH
    && num(headline.listPrice) !== null && headline.listPrice >= headline.low && headline.listPrice <= headline.high)) return no(NOTES.badRange);
  const date = analysisDate(a.created_at);
  if (!date) return no(NOTES.noDate);
  // The middle of the counted rents is needed to leave odd-priced homes off the page. Without it the page is withheld:
  // the screen must never quietly skip a screen that protects the owner.
  if (num(midpoint) === null || midpoint <= 0) return no(NOTES.noMiddle);
  if (num(a.subject_bedrooms) === null || a.subject_bedrooms < 0 || num(a.subject_bathrooms) === null || a.subject_bathrooms < 0 || !plain(a.subject_address)) return no(NOTES.noFacts);

  const counted = (Array.isArray(comps) ? comps : []).filter(c => c && !c.exclusion_reason);
  if (countedTotal !== undefined && countedTotal !== counted.length) return no(NOTES.countsMismatch);

  const analysisDay = dayNumber(date.iso);
  const printable = printableComps(counted, { midpoint, analysisDay, subjectAddress: a.subject_address });
  const chosen = selectRows(printable, { subjectSqft: a.subject_sqft, subjectSubdivision: a.subject_subdivision });
  if (chosen.length < MIN_TABLE_ROWS) return no(notEnoughRows(chosen.length));
  const rows = chosen.map(c => shapeRow(c, { analysisDay }));

  const { street, city } = splitAddress(a.subject_address);
  const addressLine = city ? `${street}, ${city}.` : (/\.$/.test(street) ? street : `${street}.`);
  const isLow = label === 'low';
  const range = rangeText(headline.low, headline.high);

  const view = {
    templateVersion: OWNER_VIEW_TEMPLATE_VERSION,
    level: isLow ? 'low' : LEVEL_WORDS[label].toLowerCase(),
    title: TEXT.title,
    asOfLine: `${TEXT.asOfPrefix}${date.text}`,
    asOfDate: date.iso,
    brand: { wordmark: WORDMARK, dre: `DRE License # ${DRE_LICENSE}` },
    intro: [seg('Below is a comparative analysis for '), seg(addressLine, true, true), seg(TEXT.introAfter)],
    facts: [seg(factsSentence(a))],
    range: isLow
      ? [seg(TEXT.lowRangeBefore), seg(range, true), seg(TEXT.lowRangeAfter)]
      : [seg(TEXT.rangeBefore), seg(range, true), seg(TEXT.rangeAfter)],
    agreement: isLow ? null : [seg(TEXT.agreementLead), seg(LEVEL_WORDS[label], true), seg(TEXT.agreementAfter)],
    goal: isLow ? null : [seg(TEXT.goalBefore[normalizeOwnerGoal(headline.goal)]), seg(money(headline.listPrice), true), seg(TEXT.goalAfter)],
    ends: isLow ? null : [seg(TEXT.ends)],
    table: { heads: TEXT.tableHeads.slice(), rows },
    key: TEXT.key,
    countLine: countSentence(counted, rows.length, analysisDay),
    disclaimer: TEXT.disclaimer,
    footer: FOOTER_LINES.slice(),
  };

  const problems = selfCheck(view, { rangeLow: headline.low, rangeHigh: headline.high, listPrice: isLow ? null : headline.listPrice });
  if (problems.length) return no(NOTES.wording);
  return { ownerView: view, ownerViewNote: null };
}

module.exports = {
  OWNER_VIEW_TEMPLATE_VERSION, COMPANY_NAME, WORDMARK, DRE_LICENSE, OFFICE_ADDRESS, OFFICE_PHONE, OFFICE_EMAIL, PAGE_TIME_ZONE,
  MAX_TABLE_ROWS, MIN_TABLE_ROWS, OUTLIER_SHARE, LEFT_OFF_FLAGS, TEXT, LEVEL_WORDS, FOOTER_LINES, NOTES, notEnoughRows,
  FORBIDDEN_WORDS, FORBIDDEN_PHRASES, FORBIDDEN_PAGE_PHRASES, ALLOWED_PHRASES,
  dayNumber, monthYear, analysisDate, splitAddress, printableComps, selectRows, shapeRow, rangeText, goalSentence,
  countSentence, factsSentence, ringMiles, monthsBack, findForbiddenTerms, fixedWording, maskNumbers, ownerViewStrings, selfCheck, buildOwnerView,
};
