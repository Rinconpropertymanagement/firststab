# Social Media Inventory — Rincon Management (2026-11-06)

Read-only discovery. Nothing was posted, scheduled, connected, disconnected or changed.
Sources: Meta Ads connector (read calls only), Peter's Gmail (search only), the two handoff
docs in this folder, a public web search. Gaps are marked **UNVERIFIED**; nothing is guessed.

## 1. Accounts and channels

| Channel | What exists | Evidence | Who administers it | Status |
|---|---|---|---|---|
| **Facebook Page** | "Rincon Property Management" (page id 855891961107338). Accepted Meta's lead-ads terms. | Meta Ads connector, listed under the Rincon ad account (109516666076782) and under Peter's login. | UNVERIFIED. The Page roles list needs a signed-in look. | Page is reachable by Peter's login. |
| **Instagram** | @rinconpropertymanagement (id 17841402278992254), linked to the ad account. | Meta Ads connector. | UNVERIFIED (who owns the login). | Last post 2026-10-25. |
| **YouTube** | Channel "Rincon Property Management", a Google "brand account" (notices go to rincon-property-5946@pages.plusgoogle.com, which lands in Peter's inbox). YouTube sent an October "Creator Month in Review" on 2026-11-05. | Gmail notices Oct 30 and Nov 5. | UNVERIFIED. Peter gets the notices, so he is at least a manager or owner. | Exists; activity level UNVERIFIED. |
| **Yelp for Business** | Business page "Rincon Property Management". A $30/month "Business Highlights" upgrade was cancelled 2026-11-01. Yelp lead and message emails reach Peter. Yelp marketing emails also go to kenya@ and brian@. | Gmail from Yelp. | UNVERIFIED. Handoff doc says Jackie held a Yelp login. | Page live; paid upgrade off. Jackie's proposed $10/day Yelp ad (Oct 27): UNVERIFIED whether it ever started. |
| **LinkedIn** | Peter's personal profile only (receives notices). No evidence of a company page. | Gmail from LinkedIn. | Peter (password reset 2026-10-29). | Company page: UNVERIFIED either way. |
| **Google Business Profile** | Not confirmed. Local Services Ads (a separate Google product) stopped 2026-08-29. | Handoff doc. | UNVERIFIED. | Needs a look. This is the one that matters most for local search. |
| **TikTok / X / Nextdoor / other** | No evidence of any. | None found. | n/a | Treat as none until Peter says otherwise. |

Third-party sites list Rincon (BiggerPockets, MapQuest, Expertise.com). Their review counts conflict
(for example Yelp shown as 61 and 147 reviews) and are secondhand, so **do not quote them**. Real
numbers have to come from the platforms.

## 2. Access gaps: Jackie and Francisco

- **Jackie (terminated 2026-10-29):** the handoff doc says she held Yelp, Zapier, PMW, APM, Google Ads
  logins. It does not list Facebook, Instagram or YouTube logins. Whether she was a Page admin, held the
  Instagram password, or had two-step verification on her phone is **UNVERIFIED**. Instagram was posting
  about 2 to 3 times a week through Oct 25, always near noon, which suggests a scheduler. That tool and
  its login are not identified.
- **Francisco (ex-contractor, ended Jul 16-17):** his personal Facebook user was what connected the ad
  account to HubSpot until Oct 28. He built the Facebook pixel. Whether he still has a role on the Page,
  the ad account or the Business portfolio is **UNVERIFIED**.
- **Already done by Peter (from email trail):** Facebook sent a business-email verification to
  info@rinconmanagement.com on 2026-10-29 and password-change alerts on the Facebook profile
  shown as "Mackenzie Peter" on 2026-10-30. LinkedIn password reset 2026-10-29. These look like Peter locking things down
  himself, but he should confirm they were his.
- Peter's personal Meta ad account (307259050) is restricted, per the Meta Ads session note. The ads run
  under the Rincon business portfolio.

## 3. HubSpot

- The HubSpot social tools failed: **the HubSpot connection lacks the `social.read` permission**.
  So channels, scheduled posts and HubSpot social analytics could not be read. Fix: reconnect the
  HubSpot app and tick the social permission (or an admin may need to approve it).
- The marketing inventory shows a campaign named "Social Media Content" with zero activity, which hints
  social was not run through HubSpot Social. UNVERIFIED until the permission is fixed.
- Facebook ad account disconnected from HubSpot 2026-10-28. A Facebook lead-ad form
  ("Your home rented in two weeks!") has 0 submissions and the ad looks off.

## 4. What was posted and how it did

Instagram only (from the Meta connector; it returned the newest 25 posts, more exist).

- **Cadence:** 12 posts between Sep 10 and Oct 25 (roughly 2 a week). Before that there were long gaps
  (nothing Feb 9 to May 26; nothing Aug 8 to Sep 9). **Nothing since Oct 25.**
- **Content mix:** owner-education carousels and images (vacancy cost, self-managing math, insurance and
  California law updates), Vendor Open House promo and recap, event invites, a realtor referral reel.
  The Oct 25 post links to the blog on mkt.rinconmanagement.com (the paused blog-redirect issue).
- **Engagement (likes / comments), recent posts:** Oct 25: 2/0. Oct 23 (Open House thank-you): 3/0.
  Oct 21: 1/0. Oct 15: 2/0. Oct 11: 1/2. Oct 7: 2/0. **Best: Oct 4 Open House reel: 13/7.** Next best:
  Jan 27 reel: 9/0. Typical post is 1 to 5 likes, almost no comments.
- **Follower count, reach, impressions, clicks:** not available through this connector. **UNVERIFIED.**
- **Facebook Page and YouTube performance:** not read (no access path without sign-in).
- **Scheduled / queued posts under Jackie's name:** **cannot tell.** HubSpot social is blocked, and the
  Meta Business Suite planner requires Peter to sign in (the pane showed a login page). Open question.

## 5. Related facts

- Meta ads: two boosted-post campaigns live; another session owns that. Not touched.
- Marketing job description Jackie drafted (Oct 14) lists "PPC, social, KPI reporting", so social was part
  of that role.
- Instagram captions carry the DRE license number and sometimes client reviews; the Feb 9 post quotes a
  client's 5-star Yelp review. Anything similar going forward needs a consent check.

## 5b. Meta sign-in check, 2026-11-06 (Peter signed in; read-only)

Business portfolio "Rinconpropertymanagement" (id 159917671827093). Three people in it:
1. **Peter McKenzie (peter@rinconmanagement.com)**: Full access. Last active today.
2. **A second "Peter McKenzie" (user id 100051701466022)**: Partial access to the portfolio, but **Full
   access to the Facebook Page**, partial on Instagram, plus the personal ad account and two pixels.
   Last active Nov 5. Most likely Peter's personal Facebook profile.
3. **"Rinconpropertymanagement" (@rinconpropertymanagement)**: an identity created through the Instagram
   login, **Full access to everything**, last active **Oct 29**. Who knows this login is **unknown**;
   it is the most likely Jackie-held credential.

- Facebook Page "Rincon Property Management": 3 people, all Full access (the three above). Owned by the
  portfolio. **No Jackie or Francisco in the portfolio.** Older Page-level roles outside the portfolio were
  not checked.
- **Scheduled posts: none.** Drafts: none seen.
- **Two ad accounts** (Meta Ads connector): 109516666076782 (named "Peter McKenzie", inside the portfolio)
  is **ACTIVE**, and is the one running the live ads. 241214670656454 ("Rincon Property Management", **not
  inside any business portfolio**) is **DISABLED** by Meta for "unusual activity". The red "we restricted
  your ad account" banner in Business Suite refers to this disabled one. Its owner is unknown (candidate:
  Francisco or Jackie's setup). Peter did not request a review; nothing was clicked.
- Peter decided 2026-11-06 to **leave the disabled account (241214670656454) alone**.
- **Facebook Page, last 28 days (Oct 9 to Nov 5, from Business Suite Insights):** 19.4K views, 5.1K
  viewers, 39 content interactions, 191 link clicks, 202 Page visits, 5 new follows. Views climbed in the
  last two weeks, which overlaps the two boosted-post ads; how much is paid is **UNVERIFIED**.
- **Google Business Profile (checked 2026-11-06):** "Rincon Property Management", 1500 Palma Dr Suite 280,
  Ventura, verified, the only business in the account. Google's own panel shows 4.6 stars from 267 Google
  reviews and a linked Google Ads summary. Peter read the People and access screen: **Jackie and Francisco
  are not listed.** Peter manages it.
- **Passwords:** Peter says he changed all social passwords when Jackie left (matches the Oct 29-30 Facebook
  and LinkedIn alerts) and confirmed the @rinconpropertymanagement Instagram recovery email and phone are
  his. Two-step verification state on that Instagram was not seen.
- **YouTube:** Peter had already checked the channel's permissions and reports Jackie and Francisco are
  not on it (his word; not seen by Claude).
- **Yelp:** Peter says access check done too (his word; not seen by Claude).
- **Calendar (checked 2026-11-06):** Meta Business Suite Scheduled tab for Page + Instagram: "No scheduled
  posts". Nothing is queued past the Oct 25 post. HubSpot Social calendar: could not read (permission).
  The only calendar found in Drive is "CONTENT CALENDAR" (Google Doc, created 2026-07-10), a **topic list
  with no dates or channels locked in**: 11 post ideas tagged by channel (LinkedIn/Facebook/Instagram/
  YouTube-Reel) plus 6 extra topics. A second doc "PERSONAL CONTENT LIST TO BE CREATED" (Peter's, Oct 26)
  lists 10 article ideas. Older template calendars from 2024/2025 also exist ("03 Monthly Social
  Calendars" folders, "01 Rincon Content Calendar 2025.xlsx"); they are old, not the live plan.
- **Where Jackie scheduled posts (search 2026-11-06):** her working doc is "Shared Doc - MKT / DIR" (Google
  Doc, now in Peter's Drive). Its Week 40 (Sep 28 to Oct 4) list shows "Schedule content 2nd batch" done
  and "Content creation - 3rd batch - finalize / send for approval" (a "3rd batch, 3 weeks"). Its DONE list
  includes "Hubspot social" and "Connect platforms to HubSpot where possible. linked in". Best lead: she
  scheduled in **HubSpot Social** in 3-week batches. A 3-week third batch started in early October would
  run out right around Oct 25, which matches the last post (**inference, not confirmed**). Meta Business
  Suite shows nothing scheduled, so a HubSpot Social queue is the remaining place any future-dated posts
  could sit. Needs Peter signed in to HubSpot Social, or the HubSpot connector reconnected with
  `social.read`.
- **Peter looked at HubSpot Social himself (2026-11-06): last post was 10/25.** So nothing is queued
  anywhere (Meta empty, HubSpot shows nothing after 10/25). The HubSpot connector still lacks `social.read`;
  no longer needed for this question.
- The same doc says the hello@ mailbox "holds the facebook" login, and lists a "rinconpm.social@" mailbox.
  Check that hello@ and rinconpm.social@ recovery access is Peter's.
- **SECURITY:** that doc contains a plain-text username and password for the communications@ mailbox
  (Jackie's). Rotate it and delete it from the doc. (Password deliberately not copied here.)
- Not read: Instagram follower count and Insights, YouTube numbers.

## 6. Proposed plan (needs Peter's yes)

Step 1, still read-only: Peter signs in to Meta Business Suite in the browser pane; Claude then reads
(without changing) who has Page and Instagram roles, whether any posts are scheduled, and follower and
reach numbers. Peter also checks the Google Business Profile, YouTube Studio and Yelp for Business
"users/permissions" screens. Step 2: Peter reconnects HubSpot with the social permission so we can see
HubSpot's side. Step 3: write a short "access to move to Peter" checklist (remove Jackie and Francisco,
turn on two-step verification, put credentials in Notion). Step 4: only after Peter says what he wants
from social, propose a posting approach. Anything aimed at tenants or applicants goes through Asimov and
Mason first.

## 7. Questions for Peter

1. What do you want social media to do for Rincon: get owner leads, recruit vendors, show up in local
   search, keep the brand alive, or just protect what exists?
2. Who should post, and how much do you want to review: Claude drafts and you approve each one, or
   something lighter?
