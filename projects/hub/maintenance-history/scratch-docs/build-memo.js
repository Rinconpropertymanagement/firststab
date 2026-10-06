const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  Header, Footer, PageNumber, LevelFormat, convertInchesToTwip,
} = require('docx');
const fs = require('fs');

const PAGE = { size: { width: 12240, height: 15840 } }; // US Letter, DXA

const COLORS = {
  heading: '1F2937',
  accent: '1D4ED8',
  muted: '6B7280',
  ruleBorder: 'D1D5DB',
  tableHeaderBg: 'EFF6FF',
};

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 480, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.ruleBorder, space: 4 } },
    children: [new TextRun({ text, bold: true, size: 30, color: COLORS.heading })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 140 },
    children: [new TextRun({ text, bold: true, size: 24, color: COLORS.heading })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 220, after: 100 },
    children: [new TextRun({ text, bold: true, size: 21, color: COLORS.heading })],
  });
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 160, line: 276 },
    children: [new TextRun({ text, size: 21, ...opts })],
  });
}
function pMixed(runs, opts = {}) {
  return new Paragraph({ spacing: { after: 160, line: 276 }, ...opts, children: runs });
}
function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'main-bullets', level },
    spacing: { after: 100, line: 276 },
    children: [new TextRun({ text, size: 21 })],
  });
}
function numbered(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'main-numbers', level },
    spacing: { after: 100, line: 276 },
    children: [new TextRun({ text, size: 21 })],
  });
}
function quote(text) {
  return new Paragraph({
    indent: { left: 360 },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: COLORS.accent, space: 8 } },
    spacing: { after: 200, before: 100, line: 276 },
    children: [new TextRun({ text, italics: true, size: 21, color: '374151' })],
  });
}
function calloutLabel(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 20, color: COLORS.accent, allCaps: true })],
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 2000, type: WidthType.DXA },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: COLORS.tableHeaderBg } : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: !!opts.header, size: 19, color: opts.header ? COLORS.heading : '1F2937' })],
    })],
  });
}

function makeTable(colWidths, headerRow, rows) {
  const total = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headerRow.map((t, i) => cell(t, { header: true, width: colWidths[i] })) }),
      ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: colWidths[i] })) })),
    ],
  });
}

const titlePage = [
  new Paragraph({ spacing: { before: 2000, after: 100 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'RINCON MANAGEMENT', size: 22, color: COLORS.muted, allCaps: true, characterSpacing: 20 })] }),
  new Paragraph({ spacing: { after: 300 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Fair Housing Compliance Review', bold: true, size: 44, color: COLORS.heading })] }),
  new Paragraph({ spacing: { after: 600 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Memorandum for Outside Counsel Review', size: 26, color: COLORS.accent })] }),
  new Paragraph({ spacing: { after: 80 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Prepared for: Peter McKenzie, CEO, Rincon Management', size: 20, color: '374151' })] }),
  new Paragraph({ spacing: { after: 80 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Prepared by: Internal technology team, with AI-assisted research and drafting (Claude / "Jarvis")', size: 20, color: '374151' })] }),
  new Paragraph({ spacing: { after: 80 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Date: September 4, 2026', size: 20, color: '374151' })] }),
  new Paragraph({ spacing: { before: 700, after: 200 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'PRIVILEGED & CONFIDENTIAL — PREPARED FOR THE PURPOSE OF OBTAINING LEGAL ADVICE', bold: true, size: 18, color: 'B91C1C' })] }),
  new Paragraph({ spacing: { after: 2000 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Nothing in this memorandum constitutes legal advice. This document is an internal, non-lawyer analysis of two Fair Housing compliance questions, prepared specifically to be reviewed, corrected, and superseded by qualified California outside counsel before either matter proceeds.', italics: true, size: 18, color: COLORS.muted })] }),
  new Paragraph({ children: [new TextRun({ text: '', break: 1 })], pageBreakBefore: true }),
];

const toc = [
  h1('How to Use This Memo'),
  p('This memorandum covers two separate, unrelated compliance questions currently under internal review at Rincon Management, both involving the company\'s Fair Housing content-screening infrastructure for maintenance and tenant-related records. Each is self-contained and can be reviewed independently.'),
  bullet('Part One: a proposed precision improvement to an existing, already-live automated content-screening tool that flags maintenance records potentially referencing a protected characteristic.'),
  bullet('Part Two: a proposed new feature to give property-management staff operational context about owners and tenants, which surfaced real, unresolved Fair Housing questions during internal design review.'),
  p('Both sections end with a short, direct list of the specific questions Rincon is asking counsel to answer. Internal (non-lawyer) analysis and a proposed design are included throughout for context, but every conclusion below should be treated as a hypothesis for counsel to test, not a settled position.'),
];

// ============================================================
// PART ONE
// ============================================================

const part1 = [
  h1('Part One — Content-Screening Precision Redesign'),

  h2('1.1 Background: The Existing System'),
  p('Rincon\'s property-management platform (the "Hub") maintains a record of maintenance history for each property, drawn from two sources: (a) individual repair tickets synced from Rincon\'s field-service vendor, and (b) a one-time five-year historical backfill of billing records from Rincon\'s property-management software. Before any text from either source is stored or displayed to staff, it passes through an automated two-layer content check designed to catch language that touches a legally protected characteristic (race, color, disability, familial status, age, source of income, national origin, religion, sex, marital status, and genetic information).'),
  bullet('Layer 1 is a deterministic keyword scan: a fixed dictionary of terms and phrases associated with each protected category, matched against the text using word-boundary matching (i.e., matching whole words, not substrings).'),
  bullet('Layer 2 is a general-purpose AI judgment call, made at the same time the system extracts a factual summary from the source record: the AI is asked to independently flag anything protected-class-adjacent it notices, even if no dictionary word matched.'),
  bullet('The two layers are combined with a logical OR: if either layer flags the text, the record is marked flagged and excluded from ordinary display until a designated staff member reviews it. Critically, Layer 2 can only add flags Layer 1 missed — it has no mechanism to remove or override a Layer 1 keyword match, however clearly mistaken that match may be in context.'),
  p('This system has been in production use and has flagged 340 records to date, nearly all of which have already been through Rincon\'s internal human review process.'),

  h2('1.2 The Problem Identified'),
  p('Rincon\'s internal team conducted a full review of all 340 flagged records — not a sample — reading each one and cross-checking it against the live dictionary to identify exactly what triggered the flag. The findings:'),
  bullet('Approximately 91% of all flagged records (roughly 309–312 of 340) are false positives: the flagged text has no genuine connection to a protected characteristic.'),
  bullet('Virtually all of the false-positive volume is attributable to exactly six dictionary terms.'),
  makeTable(
    [2400, 3200, 4200],
    ['Term', 'Category', 'What it is actually catching'],
    [
      ['white', 'race_color', 'Paint color, appliance color, a water-heater brand name ("Bradford White," 60+ occurrences)'],
      ['black', 'race_color', 'Paint/fixture color, "black mold," "black widow" spiders'],
      ['blind', 'disability_health', 'Window blinds (the household item), not a visually-impaired person'],
      ['diagnosis / diagnosed', 'disability_health', 'A vendor diagnosing a mechanical fault (e.g., a plumbing or HVAC issue), not a medical diagnosis'],
      ['too old / too young for', 'age', 'A smoke detector or door hardware described as "too old," not a person'],
    ],
  ),
  p(''),
  p('Of the 214 records flagged under the "race_color" category, every single one matched the bare word "white" or "black"; zero matched any term actually referring to race or ethnicity (e.g., no record ever matched "hispanic," "asian," "caucasian," "race," or similar). Of 95 relevant "disability_health" records, 50 matched "blind" (meaning window blinds) and 45 matched "diagnosis"/"diagnosed" (meaning a mechanical diagnosis). A genuine, correctly-flagged subset does exist and is small: a small number of records (roughly 10–12 of 340) are clean, correct catches — for example, a templated safety-intake question asking whether an infant, elderly, or disabled resident lives in a home before certain heat-related work, and one instance of a tenant reporting a genuine health concern.'),
  p('Separately, Rincon confirmed that the merge logic described above (Layer 1 OR Layer 2) means Layer 2\'s AI judgment is powerless to correct a Layer 1 false positive: even where the AI, reading the full sentence, would obviously recognize "Bradford White" as a water-heater brand rather than a reference to race, that correct judgment is never given the opportunity to override the keyword match.'),

  h2('1.3 The Proposed Redesign'),
  p('Rincon\'s team previously considered, and internal review rejected as insufficient, a simple fix of excluding specific known false-positive phrases (e.g., "Bradford White") from the dictionary. That approach was rejected because it creates a permanent, static exclusion: once "white" is excluded as a false positive, the system would be permanently blind to any future record that genuinely does reference a person\'s race using that same word, since the underlying matcher only ever sees the bare word "white," never the surrounding phrase.'),
  p('The design now under review instead proposes a two-tier treatment of the dictionary:'),
  calloutLabel('Tier A — unchanged'),
  p('Every dictionary term that produced zero false positives in the full 340-record review (this includes actual race/ethnicity terms, religion, disability terms other than "blind," "wheelchair," "pregnant," "deaf," all familial-status phrases, and the entire source-of-income list — see Section 1.5). A Layer 1 match on a Tier A term continues to flag the record immediately, exactly as today. No change.'),
  calloutLabel('Tier B — new, limited to six terms'),
  p('white, black, blind, diagnosis, diagnosed, too old / too young for. A Layer 1 match on one of these six terms no longer flags the record automatically. Instead, it triggers a single, narrow, targeted AI call asking a forced, specific question about that exact occurrence — for example: "Does the word \'white\' in this sentence refer to a person\'s race, or to something else (an object, material, or brand)?" Only an answer indicating the term refers to a person results in a flag. Any call that errors, times out, or returns low confidence defaults to flagging (fail-closed) — the system never silently clears an uncertain case.'),
  p('This mechanism differs from the rejected exclusion-list approach in one structural respect that Rincon\'s internal reviewer considers legally significant: it never removes a term from the matcher\'s attention. Every future occurrence of "white" is re-evaluated fresh, on its own sentence, every time. There is no static allowlist that could become stale or overbroad.'),
  p('Rincon\'s team validated the concept (not the production mechanism itself) using a simple, deliberately crude proxy — a roughly 15-line rule checking whether the flagged word appears near an object noun (e.g., "heater," "paint," "blinds") versus a person noun (e.g., "tenant," "resident," "family," "child"). Run against all 214 real race_color records and all 95 real disability_health "blind"/"diagnosis" records, this proxy correctly resolved 91% of the color-word cases and 60% of the blind/diagnosis cases as object references, with zero instances of incorrectly resolving a case toward "person" — every case it could not confidently resolve was left as ambiguous rather than cleared. This is offered as evidence that the underlying distinction is tractable, not as evidence that the actual proposed AI mechanism will perform at this level.'),

  h2('1.4 Internal Review Findings and Required Safeguards'),
  p('Rincon\'s internal compliance reviewer evaluated this design and reached a qualified approval — approving the mechanism in principle while identifying specific, concrete requirements that must be satisfied before any of this is built. These are reproduced here in full, as they represent the current state of Rincon\'s internal analysis and the specific points on which counsel\'s independent judgment is most needed:'),
  numbered('The new logic must be implemented entirely within the content-check merge function, and must never modify the underlying keyword-matching function itself. A separate, more permissively-gated feature elsewhere in the platform (a safe-title display function for maintenance tickets) calls the same underlying keyword matcher directly; any change to that shared matcher risks silently weakening protections on that separate feature as an unintended side effect.'),
  numbered('The new mechanism must apply prospectively only, to new records created going forward. It must not automatically re-evaluate or reclassify the 340 records already flagged and (in most cases) already reviewed under the current system. Any decision to revisit the historical 340 would be made separately and explicitly, not as an automatic consequence of this change.'),
  numbered('The single "person or object" question is not adequate as a uniform template across all six terms, and must be replaced with at least three tailored question formulations: one for the two color terms, one for "blind," and one for the diagnosis/age terms — each written to fit what is actually being distinguished in that case.'),
  numbered('The question itself must be widened beyond pure grammatical person-versus-object analysis. A purely grammatical test could be defeated by language that uses object-adjacent phrasing as an indirect or coded reference to a protected characteristic (for example, describing a "white neighborhood" as a property fact). The question must explicitly ask whether the sentence, even where grammatically about an object, could reasonably be understood as a coded or indirect reference to a person\'s protected characteristic.'),
  numbered('The fail-closed default (flag on any error, timeout, or low-confidence result) is necessary but addresses only the case where the AI is uncertain. It does nothing for a confidently incorrect result. Rincon\'s reviewer requires an ongoing, periodic manual audit of a sample of "cleared as object" decisions after any deployment, on a recurring basis, not as a one-time check.'),
  numbered('Before this mechanism is ever permitted to actually suppress a flag, Rincon\'s reviewer requires a comparison period in which both the existing logic and the new logic are run against the same live, incoming data, with the new logic\'s output logged but not yet controlling anything. Every disagreement between the old and new logic during this period would be reviewed by a human before the new logic is trusted to act autonomously. Rincon\'s reviewer specifically recommends this 100%-disagreement-review approach as preferable to an unobserved "shadow mode" period, given that a real, partially ground-truthed comparison set (the 340 already-reviewed records) already exists.'),
  p('Rincon\'s internal reviewer\'s assessment is that this change modifies the flagging logic of an already-live compliance system with existing downstream dependents (an internal review queue and a grouped-review tool both already built on top of the current flagging behavior), and should be treated as a substantive change to compliance-critical logic requiring the same governance rigor Rincon applies to any such change: management approval, outside counsel review, and a defined validation/observation period before the new logic is trusted to operate autonomously — regardless of whether the new design is, in the reviewer\'s own assessment, an improvement over the status quo.'),

  h2('1.5 Source of Income / Section 8 — A Related Question Already Investigated'),
  p('Because a large share of Rincon\'s managed properties participate in Section 8 / housing-voucher programs, Rincon\'s CEO raised a related concern: whether the phrase "Section 8" and similar source-of-income terms should receive the same treatment as the six terms above, given how routinely that vocabulary is used in ordinary business operations.'),
  p('Rincon\'s team investigated this directly rather than assuming an answer. A full scan of every piece of text processed by this content-check system to date — 17,867 individual records across tickets, claims, and the historical backfill — found the phrase "Section 8" exactly twice, and no other term from the source-of-income dictionary (housing voucher, HCV, VASH, welfare, SNAP, SSI, disability income, public assistance, etc.) even once. The two occurrences were the same real repair event, billed twice, both already correctly flagged, and both already reviewed and confirmed by Rincon\'s CEO personally prior to this review.'),
  p('Rincon\'s conclusion — and the current internal recommendation — is that this category should remain unchanged (Tier A), on the basis that there is no measurable false-positive problem to correct within the specific data this system processes, and that the greater risk for this category is a missed genuine reference (a false negative), not over-flagging. Rincon\'s team notes explicitly that this finding is scoped only to the maintenance/repair text this particular system processes, and does not speak to Section 8/voucher-status references that may occur elsewhere in the company\'s operations (e.g., leasing or applicant-screening records), which this system does not touch and which were not part of this review.'),

  h2('1.6 Questions for Counsel — Part One'),
  numbered('Does the proposed two-tier design (Section 1.3), incorporating all six required safeguards identified in Section 1.4, adequately mitigate Fair Housing risk under the Fair Housing Act and applicable California law (including the California Fair Employment and Housing Act) relative to the status quo?'),
  numbered('Is the "coded or indirect reference" question formulation (Section 1.4, item 4) sufficient, or does counsel recommend a different or additional standard for the targeted AI check?'),
  numbered('Is the proposed comparison/validation period (Section 1.4, item 6) an adequate substitute for a traditional shadow-mode period, given the existing partially-reviewed dataset?'),
  numbered('Does this change require a formal risk assessment, and if so, what should its scope be?'),
  numbered('Is there any recommended retention or documentation practice for the targeted AI check\'s decisions (e.g., logging the question asked and answer given, for audit purposes) beyond what is described above?'),
  numbered('Does counsel agree with the internal recommendation in Section 1.5 to leave the source-of-income category unchanged, and is the scope limitation noted there (this finding does not extend to leasing/applicant-screening data) adequately flagged for Rincon\'s awareness?'),
];

// ============================================================
// PART TWO
// ============================================================

const part2 = [
  new Paragraph({ children: [new TextRun({ text: '', break: 1 })], pageBreakBefore: true }),
  h1('Part Two — "Known Owner/Tenant Issues" Feature Concept'),

  h2('2.1 Business Need'),
  p('Rincon\'s CEO has requested a way to give property-management staff visibility into recurring, known context about a specific owner or tenant at the moment they are handling a maintenance situation — for example, an owner with specific maintenance-approval preferences, or a documented pattern relevant to how a situation should be handled. The stated purpose throughout has been to inform staff judgment, not to feed or influence any decision about an applicant or tenant (e.g., approval, denial, screening, or renewal). The CEO has been explicit and consistent on this point throughout internal discussion.'),
  p('This concept has gone through five rounds of internal design review since it was first raised, each round substantially reshaping the proposal in response to real objections raised on both sides. That full history is summarized below because several of the open questions for counsel only make sense in light of ideas that were already proposed and rejected internally, and why.'),

  h2('2.2 Design Evolution'),

  h3('First proposal and internal objection'),
  p('The initial idea, illustrated with the CEO\'s own examples, included: (a) tracking how frequently a tenant lodges complaints, potentially summarized as a count by category; (b) noting when a tenant has threatened legal action; (c) noting neighbor disputes; and (d) using AI to read email correspondence and draft characterizations of a tenant\'s behavior for staff review and approval.'),
  p('Internal review raised a specific, cited legal concern with this design: in Revock v. Cowpet Bay West Condominium Association (9th Cir. 2017), a housing provider faced liability where internal, informal characterizations of a disabled resident\'s accommodation request — never part of any formal decision — were nonetheless admitted as evidence of discriminatory intent. The internal reviewer\'s position was that a permanent, written, timestamped record showing a pattern of scrutiny toward a specific tenant creates real exposure independent of whether that record is ever consulted before taking any action, because the record\'s mere existence and timing can itself become evidence in a later dispute.'),
  p('A further, specific point was raised regarding complaint-volume tracking: a structured, categorized count (e.g., "12 complaints in 90 days, categories: noise (4), maintenance (6), other (2)") was analyzed as potentially worse than a vague subjective label, not better, because a precise record is harder to characterize as unreliable and provides a documented timeline that could be read as showing scrutiny beginning near the time a tenant exercised a legally protected right (e.g., a habitability complaint or a disability-accommodation request).'),
  p('A narrow exception was identified as likely defensible: documented physical safety threats, active restraining orders, and active legal or police matters — categories considered to have minimal overlap with protected activity.'),

  h3('CEO\'s response and reconsideration'),
  p('The CEO raised a direct counter-argument: that informal, undocumented information-sharing among staff already occurs today with no governance, correction mechanism, or audit trail, and may itself carry more real-world risk than a reviewed, structured system — and that Rincon\'s staff are professionally trained on Fair Housing compliance and are already trusted, in the ordinary course of business, to exercise judgment without violating the law.'),
  p('On reconsideration, the internal reviewer agreed that the comparison to informal information-sharing (rather than to "no information sharing at all") is the correct baseline, and agreed that staff being unaware of a genuinely material fact is itself a real category of operational risk that had not been adequately weighed. However, the reviewer maintained that a written record is qualitatively different from an unwritten one for litigation-exposure purposes specifically — a documented, discoverable record is not rendered equivalently risky to an undocumented conversation merely because the underlying information-sharing occurs either way — and that staff training, while a genuine and relevant safeguard against a claim that a specific individual acted with discriminatory intent, does not address a claim theory based on the documentary record itself and its timing, which does not depend on the state of mind of whoever later reads it.'),

  h3('Narrowing to operational facts'),
  p('The CEO further argued that the narrow safety-exception category addresses a low-volume scenario for Rincon\'s actual operations, and that the real, common need (characterized as roughly 99% of the intended use case) is mundane operational information with no plausible connection to a protected characteristic — for example, a tenant\'s preferred contact method, a pet on the premises, an access-scheduling constraint, or a documented billing dispute with a specific vendor.'),
  p('Internal review agreed this reframing identifies a materially different, and materially lower-risk, category — a general operational-facts notes capability, gated by the same content-safety check already applied elsewhere in the platform and requiring administrator approval before any note becomes visible, structurally similar to an already-approved owner-side notes concept rather than to the complaint-tracking idea above.'),

  h3('The AI email-extraction question'),
  p('The CEO identified a real operational constraint: Rincon\'s staff capacity does not support manually authoring these operational notes at portfolio scale, and requested that AI extract this narrower category of facts directly from existing email correspondence rather than relying on manual entry alone.'),
  p('Internal review analyzed this as a materially different question from AI drafting a behavioral characterization (the original, rejected design), because extracting a neutral operational fact is not, in itself, an evaluative statement about a person. However, the review identified a specific failure mode requiring a structural safeguard: a fact\'s surface phrasing can be neutral while its underlying reason is protected — for example, "prefers text messages over phone calls" is a neutral fact, but "prefers text messages because they are hard of hearing" is not a neutral fact with an extra clause; it is a disability disclosure, and an extraction process that keeps the neutral clause while dropping only the reason clause would launder a protected disclosure into an apparently-innocuous record.'),
  p('The review also identified an independent, structural concern not resolved by careful prompt design alone: any AI process that reads full email correspondence in order to extract even a narrow category of facts necessarily processes whatever else is present in that correspondence, including sensitive content that is never stored or displayed. The review\'s position is that the resulting institutional knowledge (i.e., that Rincon\'s systems processed and were exposed to that content) is not undone merely because it was not retained, and that this is a distinct question from what gets displayed to staff. This part of the analysis specifically flagged the California Invasion of Privacy Act (CIPA) as a body of law the internal reviewer is not confident how squarely it applies to this scenario, and identified this as a question requiring an actual attorney\'s determination rather than internal analysis.'),
  p('Seven specific requirements were proposed as necessary, not sufficient in themselves, conditions for any AI-extraction design to proceed:'),
  numbered('A closed, enumerated list of extractable fact categories (e.g., contact-channel preference, access/entry logistics, pet-on-premises, named vendor dispute) — never an open-ended instruction to extract "anything useful."'),
  numbered('A hard rule that the AI must discard an entire candidate fact — not merely the reason clause — whenever the underlying reason for that fact touches a protected characteristic.'),
  numbered('The existing two-layer content check must run on the full source email before any extraction occurs; if it trips on the source text, that entire correspondence is routed to manual-only handling, not trusted to a downstream extraction filter.'),
  numbered('A human approver must edit or rewrite the note before approval — not merely click "approve" on the AI\'s exact wording — to preserve a genuine, independent human judgment rather than a rubber-stamp of an AI-formed conclusion.'),
  numbered('A contractual zero-retention data-processing agreement with whichever AI provider performs this extraction, covering the provider\'s own systems, not merely Rincon\'s application database.'),
  numbered('Logging that an extraction scan occurred (thread identifier, timestamp) without logging what the source content actually contained, to permit later audit of scope and behavior without independently creating the exposure the design is meant to avoid.'),
  numbered('Real outside counsel sign-off, specifically addressing the CIPA question above, and a defined observation/shadow period before this is trusted with live tenant correspondence.'),

  h3('Further review of the disclosure/withholding mechanism'),
  p('The CEO raised an additional, evidence-based objection: the existing content-check tooling has a demonstrated, verified history of false positives (see Part One), and the CEO stated he does not trust an automated process to silently discard information on that tooling\'s track record. His proposed alternative: route anything the system identifies as possibly protected-class-adjacent to mandatory human review rather than automatically discarding it.'),
  p('Internal review\'s response distinguished two separate risks moving in different directions under this alternative: the risk of losing genuinely useful operational information is reduced (a real improvement), but the risk the original design was built to prevent — a record showing that a human was shown protected-characteristic content about a specific person and made a deliberate decision to retain it — is not reduced, and arguably increases, since an affirmative human retention decision is, if anything, a more deliberate version of the fact pattern in Revock than an automated non-retention would have been.'),
  p('A middle design was proposed and evaluated as the more defensible option: when the extraction process withholds a candidate fact, the approving administrator sees that something was withheld and its general category (e.g., "1 item withheld — category: disability-related") without seeing the underlying content itself, preserving visibility and an audit trail (addressing the CEO\'s trust concern) without recreating the risk of an administrator being shown and choosing to retain sensitive content. This was evaluated as solving the visibility/trust problem but not the accuracy problem — it depends on first improving the underlying tooling\'s precision (see Part One), since a high-false-positive tool would otherwise generate a steady stream of "item withheld" notices that are themselves mostly noise, with an acknowledged risk that staff would begin working around a governed system that feels unreliable.'),

  h3('The scope of the CEO\'s decision-making authority'),
  p('The CEO stated directly that he owns the business and bears the risk of any exposure discussed, and that he is comfortable being the final decision-maker on these questions. Internal review\'s response — offered for counsel\'s independent evaluation, not as a settled legal conclusion — was that the CEO\'s approval is a real and necessary component of Rincon\'s own internal governance framework for a change of this sensitivity, but is not, on its own, a substitute for independent legal review: the reasoning offered internally is that a prospective tenant\'s or current tenant\'s statutory Fair Housing rights exist independently of what business risk the company\'s owner is personally willing to accept, and that the lawfulness of a given design is not established merely because the company\'s owner has approved proceeding with it.'),

  h2('2.3 Current State of the Proposed Design'),
  p('As of this writing, the concept is bifurcated into two tracks with different risk profiles and different readiness levels:'),
  calloutLabel('Owner-side notes'),
  p('General operational preferences and facts about property owners (e.g., maintenance-approval process, communication preferences). Internal review\'s current position is that this track can proceed toward a formal build specification, subject to one specific addition raised during review: owner-side notes must receive the same content-safety check as tenant-side notes, not a lighter one, because a staff member could otherwise record an owner\'s own improper preference (for example, a discriminatory instruction about who the owner does or does not want as a tenant) as an apparently-neutral "owner preference" note, which would create a written record of Rincon knowingly implementing an illegal instruction.'),
  calloutLabel('Tenant-side notes'),
  p('Limited, per current internal discussion, to (a) a narrow safety/legal-facts category (documented physical threats, active restraining orders, active legal or police matters, and accommodations already formally granted — so staff do not inadvertently act inconsistently with an accommodation they are unaware of), and (b) general operational facts extracted under the seven-requirement framework in Section 2.2, subject to the disclosure/withholding design also described there. Complaint-volume or pattern tracking of any kind, and AI-drafted behavioral characterization of a tenant, remain outside the current proposed scope and are not recommended for further design work absent counsel\'s independent view.'),
  p('No part of this feature has been built. This memorandum reflects a design concept only.'),

  h2('2.4 Questions for Counsel — Part Two'),
  numbered('Is there any version of tenant-side "known issues" tracking — including the narrowed safety/legal-facts and operational-facts categories described in Section 2.3 — that counsel considers defensible under the Fair Housing Act and California law, or does counsel recommend against building any standing, named record of this kind regardless of framing?'),
  numbered('Does the "facts versus characterization" distinction described in Section 2.2 (a neutral operational fact versus an evaluative statement about a person) hold up as a legally meaningful line, in counsel\'s independent judgment, or is the distinction less stable than internal review has assumed?'),
  numbered('Does AI processing of tenant email correspondence — even limited to extracting a narrow, enumerated category of neutral facts, and even where nothing sensitive is ever stored or displayed — raise concerns under the California Invasion of Privacy Act or any other California privacy statute? This question was specifically identified internally as one the internal reviewer is not qualified to answer.'),
  numbered('Is the "label-only" withholding design described in Section 2.2 (administrator sees that something was withheld and its general category, but not the underlying content) an adequate mitigation, or does counsel recommend a different mechanism?'),
  numbered('Does counsel agree with the internal analysis in Section 2.2 regarding the limits of the CEO\'s own risk-acceptance authority for this category of design decision?'),
  numbered('What governance process — including, if applicable, a shadow-mode or parallel-observation period, and any recommended documentation or audit practice — does counsel recommend before any tenant-side version of this feature is permitted to operate on live tenant data?'),
  numbered('Is the owner-side track (Section 2.3), including the added requirement that owner-side notes receive the same content-safety check as tenant-side notes, ready to proceed to a formal build specification, in counsel\'s view, or does counsel identify additional requirements?'),
];

const closing = [
  new Paragraph({ children: [new TextRun({ text: '', break: 1 })], pageBreakBefore: true }),
  h1('Closing Note'),
  p('Both matters described in this memorandum are currently paused pending counsel\'s review. Rincon\'s internal team is available to provide the underlying data, source code, or any additional detail counsel requires, including the full internal review record referenced throughout (all of which exists in Rincon\'s internal project documentation and can be provided on request).'),
  p('Please direct any questions to Peter McKenzie, CEO, Rincon Management (peter@rinconmanagement.com).'),
];

const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'main-bullets',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 260 } } } },
        ],
      },
      {
        reference: 'main-numbers',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 260 } } } },
        ],
      },
    ],
  },
  sections: [
    {
      properties: { page: { ...PAGE, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: 'Rincon Management — Privileged & Confidential', size: 16, color: COLORS.muted })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 16, color: COLORS.muted }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COLORS.muted }),
              new TextRun({ text: ' of ', size: 16, color: COLORS.muted }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: COLORS.muted }),
            ],
          })],
        }),
      },
      children: [...titlePage, ...toc, ...part1, ...part2, ...closing],
    },
  ],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(__dirname + '/Rincon-Fair-Housing-Compliance-Review-for-Counsel.docx', buf);
  console.log('written');
});
