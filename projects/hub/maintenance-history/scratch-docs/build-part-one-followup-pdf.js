const PDFDocument = require('pdfkit');
const fs = require('fs');

const OUT = __dirname + '/Rincon-Content-Screening-Redesign-Followup-for-Counsel.pdf';
const MARGIN = 72; // 1 inch

const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
doc.pipe(fs.createWriteStream(OUT));

const HEADING = '#1F2937';
const ACCENT = '#1D4ED8';
const MUTED = '#6B7280';
const RED = '#B91C1C';

function h1(text) {
  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(HEADING).text(text);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - MARGIN, doc.y + 2).strokeColor('#D1D5DB').stroke();
  doc.moveDown(0.6);
}
function h2(text) {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(HEADING).text(text);
  doc.moveDown(0.3);
}
function p(text) {
  doc.font('Helvetica').fontSize(10.5).fillColor('#1F2937').text(text, { align: 'left', lineGap: 3 });
  doc.moveDown(0.5);
}
function calloutLabel(text) {
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ACCENT).text(text.toUpperCase());
  doc.moveDown(0.2);
}
let numberedCounter = 0;
function numbered(text) {
  numberedCounter += 1;
  doc.font('Helvetica').fontSize(10.5).fillColor('#1F2937')
    .text(`${numberedCounter}.  ${text}`, { align: 'left', lineGap: 3, indent: 0 });
  doc.moveDown(0.5);
}
function resetNumbering() { numberedCounter = 0; }
function centered(text, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11)
    .fillColor(opts.color || '#1F2937').text(text, { align: 'center' });
}

// ---------------- TITLE PAGE ----------------
doc.moveDown(6);
centered('RINCON MANAGEMENT', { size: 11, color: MUTED });
doc.moveDown(0.6);
centered('Content-Screening Precision Redesign', { size: 22, bold: true, color: HEADING });
doc.moveDown(1);
centered('Follow-Up Memorandum for Outside Counsel Review', { size: 13, color: ACCENT });
centered('Part One of the Original Fair Housing Compliance Review', { size: 13, color: ACCENT });
doc.moveDown(1.5);
centered('Prepared for: Peter McKenzie, CEO, Rincon Management', { size: 10 });
centered('Prepared by: Internal technology team, with AI-assisted research and drafting (Claude / "Jarvis")', { size: 10 });
centered('Date: September 5, 2026', { size: 10 });
doc.moveDown(2);
centered('PRIVILEGED & CONFIDENTIAL — PREPARED FOR THE PURPOSE OF OBTAINING LEGAL ADVICE', { size: 9, bold: true, color: RED });
doc.moveDown(1);
doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(
  'Nothing in this memorandum constitutes legal advice. This document is an internal, non-lawyer analysis, prepared specifically to be reviewed, corrected, and superseded by qualified California outside counsel before this matter proceeds.',
  { align: 'center' }
);

doc.addPage();

// ---------------- HOW TO USE ----------------
h1('How to Use This Memo');
p('This is a follow-up to the memorandum Rincon sent previously, "Fair Housing Compliance Review — Memorandum for Outside Counsel Review" (September 4, 2026), which covered two separate, unrelated compliance questions under the heading "Part One" and "Part Two." Counsel\'s written opinion in response addressed Part Two (the proposed owner/tenant operational-notes feature) in full. It did not address Part One (this document\'s subject), which concerns a different, already-live system — a precision improvement to Rincon\'s existing automated content-screening tool.');
p('This memorandum reproduces Part One in full, unchanged from the original submission, along with the same six questions originally asked, so counsel can review and respond to it independently of Part Two, which is already resolved.');

// ---------------- PART ONE ----------------
h1('Part One — Content-Screening Precision Redesign');

h2('1.1 Background');
p('Rincon operates an automated, two-layer content-screening tool that scans maintenance-related text (tickets, claims, and a historical five-year backfill) for language that may reference a protected characteristic under the Fair Housing Act or California law, and flags matching records for exclusion from normal display pending human review.');
p('Layer 1 is a deterministic keyword/phrase dictionary scan. Layer 2 is an AI model that independently reviews the same text during a separate extraction step and can add its own flag. The two layers are combined with an OR: either layer flagging a record is sufficient to flag it. Critically, Layer 2 cannot remove or override a Layer 1 flag — it can only add flags, never correct them.');

h2('1.2 The Problem, With Real Data');
p('Rincon\'s team conducted a full manual review of all 340 records the current system has ever flagged (not a sample) to evaluate the tool\'s real-world accuracy.');
p('Approximately 91% of all flagged records (roughly 309–312 of 340) are false positives: the flagged text has no genuine connection to a protected characteristic.');
p('Virtually all of the false-positive volume is attributable to exactly six dictionary terms.');
p('Of the 214 records flagged under the "race_color" category, every single one matched the bare word "white" or "black"; zero matched any term actually referring to race or ethnicity (e.g., no record ever matched "hispanic," "asian," "caucasian," "race," or similar). Of 95 relevant "disability_health" records, 50 matched "blind" (meaning window blinds) and 45 matched "diagnosis"/"diagnosed" (meaning a mechanical diagnosis). A genuine, correctly-flagged subset does exist and is small: a small number of records (roughly 10–12 of 340) are clean, correct catches — for example, a templated safety-intake question asking whether an infant, elderly, or disabled resident lives in a home before certain heat-related work, and one instance of a tenant reporting a genuine health concern.');
p('Separately, Rincon confirmed that the merge logic described above (Layer 1 OR Layer 2) means Layer 2\'s AI judgment is powerless to correct a Layer 1 false positive: even where the AI, reading the full sentence, would obviously recognize "Bradford White" as a water-heater brand rather than a reference to race, that correct judgment is never given the opportunity to override the keyword match.');

h2('1.3 The Proposed Redesign');
p('Rincon\'s team previously considered, and internal review rejected as insufficient, a simple fix of excluding specific known false-positive phrases (e.g., "Bradford White") from the dictionary. That approach was rejected because it creates a permanent, static exclusion: once "white" is excluded as a false positive, the system would be permanently blind to any future record that genuinely does reference a person\'s race using that same word, since the underlying matcher only ever sees the bare word "white," never the surrounding phrase.');
p('The design now under review instead proposes a two-tier treatment of the dictionary:');
calloutLabel('Tier A — unchanged');
p('Every dictionary term that produced zero false positives in the full 340-record review (this includes actual race/ethnicity terms, religion, disability terms other than "blind," "wheelchair," "pregnant," "deaf," all familial-status phrases, and the entire source-of-income list — see Section 1.5). A Layer 1 match on a Tier A term continues to flag the record immediately, exactly as today. No change.');
calloutLabel('Tier B — new, limited to six terms');
p('white, black, blind, diagnosis, diagnosed, too old / too young for. A Layer 1 match on one of these six terms no longer flags the record automatically. Instead, it triggers a single, narrow, targeted AI call asking a forced, specific question about that exact occurrence — for example: "Does the word \'white\' in this sentence refer to a person\'s race, or to something else (an object, material, or brand)?" Only an answer indicating the term refers to a person results in a flag. Any call that errors, times out, or returns low confidence defaults to flagging (fail-closed) — the system never silently clears an uncertain case.');
p('This mechanism differs from the rejected exclusion-list approach in one structural respect that Rincon\'s internal reviewer considers legally significant: it never removes a term from the matcher\'s attention. Every future occurrence of "white" is re-evaluated fresh, on its own sentence, every time. There is no static allowlist that could become stale or overbroad.');
p('Rincon\'s team validated the concept (not the production mechanism itself) using a simple, deliberately crude proxy — a roughly 15-line rule checking whether the flagged word appears near an object noun (e.g., "heater," "paint," "blinds") versus a person noun (e.g., "tenant," "resident," "family," "child"). Run against all 214 real race_color records and all 95 real disability_health "blind"/"diagnosis" records, this proxy correctly resolved 91% of the color-word cases and 60% of the blind/diagnosis cases as object references, with zero instances of incorrectly resolving a case toward "person" — every case it could not confidently resolve was left as ambiguous rather than cleared. This is offered as evidence that the underlying distinction is tractable, not as evidence that the actual proposed AI mechanism will perform at this level.');

h2('1.4 Internal Review Findings and Required Safeguards');
p('Rincon\'s internal compliance reviewer evaluated this design and reached a qualified approval — approving the mechanism in principle while identifying specific, concrete requirements that must be satisfied before any of this is built. These are reproduced here in full, as they represent the current state of Rincon\'s internal analysis and the specific points on which counsel\'s independent judgment is most needed:');
resetNumbering();
numbered('The new logic must be implemented entirely within the content-check merge function, and must never modify the underlying keyword-matching function itself. A separate, more permissively-gated feature elsewhere in the platform (a safe-title display function for maintenance tickets) calls the same underlying keyword matcher directly; any change to that shared matcher risks silently weakening protections on that separate feature as an unintended side effect.');
numbered('The new mechanism must apply prospectively only, to new records created going forward. It must not automatically re-evaluate or reclassify the 340 records already flagged and (in most cases) already reviewed under the current system. Any decision to revisit the historical 340 would be made separately and explicitly, not as an automatic consequence of this change.');
numbered('The single "person or object" question is not adequate as a uniform template across all six terms, and must be replaced with at least three tailored question formulations: one for the two color terms, one for "blind," and one for the diagnosis/age terms — each written to fit what is actually being distinguished in that case.');
numbered('The question itself must be widened beyond pure grammatical person-versus-object analysis. A purely grammatical test could be defeated by language that uses object-adjacent phrasing as an indirect or coded reference to a protected characteristic (for example, describing a "white neighborhood" as a property fact). The question must explicitly ask whether the sentence, even where grammatically about an object, could reasonably be understood as a coded or indirect reference to a person\'s protected characteristic.');
numbered('The fail-closed default (flag on any error, timeout, or low-confidence result) is necessary but addresses only the case where the AI is uncertain. It does nothing for a confidently incorrect result. Rincon\'s reviewer requires an ongoing, periodic manual audit of a sample of "cleared as object" decisions after any deployment, on a recurring basis, not as a one-time check.');
numbered('Before this mechanism is ever permitted to actually suppress a flag, Rincon\'s reviewer requires a comparison period in which both the existing logic and the new logic are run against the same live, incoming data, with the new logic\'s output logged but not yet controlling anything. Every disagreement between the old and new logic during this period would be reviewed by a human before the new logic is trusted to act autonomously. Rincon\'s reviewer specifically recommends this 100%-disagreement-review approach as preferable to an unobserved "shadow mode" period, given that a real, partially ground-truthed comparison set (the 340 already-reviewed records) already exists.');
p('Rincon\'s internal reviewer\'s assessment is that this change modifies the flagging logic of an already-live compliance system with existing downstream dependents (an internal review queue and a grouped-review tool both already built on top of the current flagging behavior), and should be treated as a substantive change to compliance-critical logic requiring the same governance rigor Rincon applies to any such change: management approval, outside counsel review, and a defined validation/observation period before the new logic is trusted to operate autonomously — regardless of whether the new design is, in the reviewer\'s own assessment, an improvement over the status quo.');

h2('1.5 Source of Income / Section 8 — A Related Question Already Investigated');
p('Because a large share of Rincon\'s managed properties participate in Section 8 / housing-voucher programs, Rincon\'s CEO raised a related concern: whether the phrase "Section 8" and similar source-of-income terms should receive the same treatment as the six terms above, given how routinely that vocabulary is used in ordinary business operations.');
p('Rincon\'s team investigated this directly rather than assuming an answer. A full scan of every piece of text processed by this content-check system to date — 17,867 individual records across tickets, claims, and the historical backfill — found the phrase "Section 8" exactly twice, and no other term from the source-of-income dictionary (housing voucher, HCV, VASH, welfare, SNAP, SSI, disability income, public assistance, etc.) even once. The two occurrences were the same real repair event, billed twice, both already correctly flagged, and both already reviewed and confirmed by Rincon\'s CEO personally prior to this review.');
p('Rincon\'s conclusion — and the current internal recommendation — is that this category should remain unchanged (Tier A), on the basis that there is no measurable false-positive problem to correct within the specific data this system processes, and that the greater risk for this category is a missed genuine reference (a false negative), not over-flagging. Rincon\'s team notes explicitly that this finding is scoped only to the maintenance/repair text this particular system processes, and does not speak to Section 8/voucher-status references that may occur elsewhere in the company\'s operations (e.g., leasing or applicant-screening records), which this system does not touch and which were not part of this review.');

h2('1.6 Questions for Counsel');
resetNumbering();
numbered('Does the proposed two-tier design (Section 1.3), incorporating all six required safeguards identified in Section 1.4, adequately mitigate Fair Housing risk under the Fair Housing Act and applicable California law (including the California Fair Employment and Housing Act) relative to the status quo?');
numbered('Is the "coded or indirect reference" question formulation (Section 1.4, item 4) sufficient, or does counsel recommend a different or additional standard for the targeted AI check?');
numbered('Is the proposed comparison/validation period (Section 1.4, item 6) an adequate substitute for a traditional shadow-mode period, given the existing partially-reviewed dataset?');
numbered('Does this change require a formal risk assessment, and if so, what should its scope be?');
numbered('Is there any recommended retention or documentation practice for the targeted AI check\'s decisions (e.g., logging the question asked and answer given, for audit purposes) beyond what is described above?');
numbered('Does counsel agree with the internal recommendation in Section 1.5 to leave the source-of-income category unchanged, and is the scope limitation noted there (this finding does not extend to leasing/applicant-screening data) adequately flagged for Rincon\'s awareness?');

// ---------------- CLOSING ----------------
doc.addPage();
h1('Closing Note');
p('This matter is currently paused pending counsel\'s review. Rincon\'s internal team is available to provide the underlying data, source code, or any additional detail counsel requires, including the full internal review record referenced throughout (all of which exists in Rincon\'s internal project documentation and can be provided on request).');
p('Please direct any questions to Peter McKenzie, CEO, Rincon Management (peter@rinconmanagement.com).');

// ---------------- HEADER/FOOTER ON EVERY PAGE ----------------
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text('Rincon Management — Privileged & Confidential', MARGIN, 30, { align: 'right', width: doc.page.width - MARGIN * 2, lineBreak: false });
  // Footer sits inside the page's bottom margin band. pdfkit's .text() treats
  // anything below (page.height - margins.bottom) as overflow and silently
  // starts a NEW page to hold it — confirmed by a first pass of this script
  // that produced 7 extra blank trailing pages, one per real page, each
  // containing only the footer. Zeroing the bottom margin for this one call
  // (then restoring it) draws the footer in place instead of paginating.
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - 40, { align: 'center', width: doc.page.width - MARGIN * 2, lineBreak: false });
  doc.page.margins.bottom = savedBottom;
}

doc.end();
