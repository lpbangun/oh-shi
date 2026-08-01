# Discovery source policy

Last reviewed: 2026-07-31.

Investor and accelerator pages are discovery evidence only. OH SHI publishes a
job only after a successful, complete fetch from the employer's Ashby,
Greenhouse, Lever, supported Workable, Recruitee, Personio, or SmartRecruiters
source, or an
actionable first-party structured career page. Glassdoor, LinkedIn, X, and
authenticated social networks are never scraped.

## Ranking method

The initial universe is ranked by a balanced review of:

1. active private-company portfolio breadth;
2. recent startup investment activity;
3. relevance to US startup hiring;
4. quality of official portfolio evidence; and
5. availability of permitted public discovery mechanisms.

The list is not an assets-under-management league table. Hiring relevance and
first-party evidence are weighted more heavily than raw historical investment
count. The four mandatory ecosystems—A16z, General Catalyst, Khosla Ventures,
and Y Combinator—remain configured regardless of future ranking changes.

## Current registry

| Priority | Source | Official discovery evidence | Job discovery | Access |
| --- | --- | --- | --- | --- |
| 1 | a16z | https://a16z.com/portfolio/ | https://portfoliojobs.a16z.com/jobs | Awaiting permission / manual import |
| 2 | General Catalyst | https://www.generalcatalyst.com/portfolio | https://jobs.generalcatalyst.com/jobs | Awaiting permission / manual import |
| 3 | Khosla Ventures | https://www.khoslaventures.com/portfolio | https://jobs.khoslaventures.com/jobs | Awaiting permission / manual import |
| 4 | Sequoia Capital | https://sequoiacap.com/our-companies/ | https://jobs.sequoiacap.com/jobs | Awaiting permission / manual import |
| 5 | NEA | https://www.nea.com/portfolio | https://careers.nea.com/jobs | Awaiting permission / manual import |
| 6 | Lightspeed | https://lsvp.com/companies/ | — | Blocked by terms / manual import |
| 7 | Accel | https://www.accel.com/companies | https://jobs.accel.com/jobs | Awaiting permission / manual import |
| 8 | Bessemer | https://www.bvp.com/companies | https://jobs.bvp.com/jobs | Blocked by terms / manual import |
| 9 | Insight Partners | https://www.insightpartners.com/portfolio/ | https://jobs.insightpartners.com/jobs | Blocked by terms / manual import |
| 10 | Y Combinator | https://www.ycombinator.com/companies | https://www.ycombinator.com/jobs | Blocked by terms / manual import |

All domains above are first-party organization domains or their publicly linked
portfolio-job subdomains. Each discovery request checks the source's current
`robots.txt` before fetching. A blanket disallow records a source failure; the
pipeline does not bypass it. Authentication challenges, anti-bot controls, and
rate limits are likewise treated as blockers. Terms or permission changes must
be represented by changing the D1 source `access_mode` to `manual_import` or
`awaiting_permission`.

A16z currently has no usable `robots.txt` guidance (the path returns a 404), so
its otherwise-public portfolio is not fetched automatically. The configured
Getro portfolio-job surfaces also return an explicit instruction to obtain data
through Getro's API (`api@getro.com`); OH SHI does not proxy or scrape around
that response. Those surfaces remain discovery references pending permission,
not ingestion endpoints.

A refreshed 2026-07-30 terms review removed General Catalyst and Sequoia from
automatic public-page discovery. General Catalyst grants site access for
personal, noncommercial use, and Sequoia reserves its site materials while
limiting download/use to personal information. Their official terms are:

- https://www.generalcatalyst.com/terms-and-conditions
- https://sequoiacap.com/legal/

Those restrictions do not support automated ingestion into this public product,
so both sources now report `awaiting_permission` and are not fetched. Khosla
and Accel likewise have no clear automation permission; NEA restricts copying
for commercial use; Lightspeed prohibits robots and scraping; Bessemer
prohibits screen/database scraping; Insight prohibits robots, scrapers, and
crawlers; and Y Combinator's official legal terms prohibit scraping site
content. All ten investor/accelerator sources remain configured for truthful
permission/manual receipts, but none is currently fetched automatically.

No documented general-purpose portfolio API was found in the official
resources during this review. The public-page mechanism therefore extracts
only explicit outbound HTTPS links and places them in a reviewable queue.
Candidates are deduplicated by normalized domain. Onboarding then resolves the
employer website, detects a supported ATS or first-party structured career
surface, and requires a complete canonical fetch containing at least one
US-eligible open role.

## Measured 500-domain candidate pilot

The canonical domain-registry pilot uses the official Wikidata Query Service,
not an investor directory whose terms prohibit automation. Wikidata documents
the query service as a programmatic data-access surface and publishes its
structured data under CC0:

- Data access and query-service guidance:
  https://www.wikidata.org/wiki/Wikidata:Data_access
- Stable interface policy:
  https://www.wikidata.org/wiki/Wikidata:Stable_Interface_Policy/en
- Structured-data copyright/license:
  https://www.wikidata.org/wiki/Wikidata:Copyright
- Startup-company class used by the explicit cohort:
  https://www.wikidata.org/wiki/Q129238

`pnpm pilot:domains` makes two bounded, attributable queries with a descriptive
user agent and writes a local import artifact under ignored `outputs/`. It
combines Wikidata items explicitly classified under startup company with a
secondary cohort of software-company candidates founded since 2015, then
normalizes them using the Public Suffix List and selects exactly 500 distinct
registrable domains. The secondary cohort is deliberately classified
`recent_software_candidate`, not “startup”, because inception and industry
alone do not prove startup status.

Multiple Wikidata `P856` website values for one item are stored as untrusted
website observations, not aliases. Alias and acquisition relationships require
their own explicit first-party or authorized evidence, permission decision,
terms URL, and observation timestamp. Acquisitions are stored as directed
provenance and never participate in alias resolution.

Every pilot record enters the registry as `activity_state=unknown` and
`review_status=pending`. The import route does not create a company, job,
hiring signal, or discovery-queue activation. A domain can advance only after
permitted first-party inspection establishes current company identity and a
canonical careers source. This keeps stale, acquired, misclassified, and
non-company Wikidata records out of the verified-opening board.

### Read-only yield measurement

`pnpm run pilot:measure-yield` with `--offset=0`, `--limit=25`, and an explicit
`--as-of=2026-07-31T00:00:00.000Z` measures a bounded slice without D1 access
or import. One robots-aware public session is reused per domain, HTTPS is
required, the request/page budget is fixed, and only same-site career paths are followed.
Supported ATS candidates are normalized to board roots. Zero candidates means
“not detected”; more than one distinct board is an ambiguity that cannot be
selected automatically. Detection alone never counts as a job: the detected
canonical source must return a complete validated collection, and only current
US-eligible normalized roles count.

The runner freezes the exact 500-domain input hash, full probe configuration,
implementation-source hash, user agent, adapter/detection versions, and
eligibility timestamp in append-only JSONL receipts. A resume is accepted only
when the input, configuration, implementation, and schema match; otherwise it
fails closed and requires a new receipt path. The summary is derived from the
latest receipt for each domain and reports provider, candidate classification,
probe disposition, complete canonical collections, verified-US companies, and
verified-US jobs. It also records bounded, query-stripped links from permitted
first-party pages to unsupported career-looking hosts. Those hosts are not
fetched and remain leads, not detected or verified sources. Outputs remain
under ignored `outputs/`; the measurement cannot activate a registry record or
mutate production.

A July 31, 2026 frozen v1.0 measurement covered all 500 domains. It detected 25
single supported boards plus one ambiguous company, completed 22 canonical
collections, and verified 171 US roles across 11 companies. Provider yield was
Ashby 44 roles across 8 companies, Greenhouse 123 across 2, Lever 4 across 1,
and zero eligible roles from the two complete Workable boards. Both detected
Personio collections failed closed. The explicit-startup cohort yielded 101
roles across 5 companies; the recent-software-candidate cohort yielded 70
across 6. All 11 verified companies are absent from the current 11-company
production baseline, but nothing was imported or activated.

The separate frozen v1.1 cohort also covered all 500 domains under the same
input and eligibility time, with receipt schema and probe version 1.1. It
detected 24 single supported boards plus one ambiguity, completed 22 canonical
collections, and verified 91 US roles across 11 companies. Provider yield was
Ashby 44 roles across 8 companies, Greenhouse 43 across 2, Lever 4 across 1,
and zero eligible roles from the two complete Workable boards. Gusto accounted
for the 80-role difference from v1.0: all five permitted first-party seed paths
returned HTTP 403 during v1.1, so no board could be detected. This is recorded
as live-access drift rather than silently attributed to the detector. Lokalise
was correctly detected as Greenhouse board `lokalise` and yielded one current
US role. Neither cohort was rewritten or combined.

The v1.1 unsupported-host evidence was sparse and concentrated. LinkedIn
appeared on three input domains, Y Combinator on two, and every ATS-like host
appeared for only one employer. General job boards and application-only links
are not canonical employer feeds. No unsupported vendor had enough
multi-employer prevalence to justify another adapter from this cohort.

The measurement also exposed a Greenhouse embed link whose stable board
identity lives in the exact `for` query parameter. The old detector incorrectly
used `embed` as the board ID and received 404. The corrected detector
normalized the board to `lokalise`; a separate read-only canonical verification
found one current US role. That correction is not retroactively added to the
frozen 171-role v1.0 result.

The first rejected pilot query used Wikidata item `Q131734`, which is the
brewery class rather than startup company. Its returned rows were discarded
before any artifact or database write. The corrected query uses `Q129238` and
the pilot generator asserts an exact 500-domain output.

Y Combinator's directory is not used to seed the pilot. Its current official
conditions prohibit scraping/data mining and restrict reproduction:
https://www.ycombinator.com/legal/. It remains manual/permission-gated unless
written authorization or a separately consented source is available.

## Manual import and blocked access

`POST /api/internal/discovery/import` is the protected manual import path for
licensed feeds or reviewed records. It accepts an array of `name`,
`website_url`, `investor_source_id`, and `evidence_url` records using the same
`INGEST_TOKEN` bearer credential as refresh. It uses the same domain
deduplication, investor relationship, queue, ATS detection, and canonical
verification logic as automated discovery.
Sources marked `manual_import` or `awaiting_permission` are reported but not
fetched. Glassdoor may be represented only through this path; no Glassdoor
ingestion exists.

## Operational limits

Each scheduled run attempts every enabled investor source, processes 25 queued
candidates when available, and activates at most 10 verified companies. It
records failures and reasons per source and candidate. Scheduled refresh runs
every six hours. Candidate and relationship writes are conflict-safe, making
retries idempotent and preserving overlapping investor relationships.
Each public portfolio keeps a durable bounded cursor so successive runs advance
through its company pages. Candidates moved to `needs_review`, `unsupported`,
or `rejected` remain available for operator review but do not starve newly
discovered records; an operator must explicitly reset one to `discovered` to
retry it.

## Canonical snapshot quarantine

A response can be malformed, fail schema validation, or satisfy a provider's
schema while still being unexpectedly truncated. Parser and incomplete-payload
failures produce a durable quarantined snapshot before any job mutation.
For schema-valid responses, the canonical refresh compares overlap between the
new eligible-job identity set and the source's currently open identities. New
or replacement source IDs cannot disguise disappearance of old IDs. It
quarantines the snapshot when all three conservative guard conditions hold:

1. the source previously had at least 20 verified-open jobs;
2. at least ten would disappear; and
3. more than 50% would disappear.

A quarantined snapshot records the run/source/board identity, provider, parser
version, counts, stable identity fingerprint, exact existing/observed/missing
membership, and machine-readable reason. It does not open, update, or close
jobs; does not advance `last_successful_at`; and marks the source quarantined
for operator evidence. A later complete snapshot within the guard clears the
source quarantine through the normal successful-refresh path. Small ordinary
deltas, including the exact 50% boundary, retain authoritative-board closure
behavior.

Protected `GET /api/internal/canonical/snapshots?snapshotId=...` is a DB-only,
read-only inspection surface. Legacy snapshots without exact membership or
board identity and parser/incomplete-payload quarantines are explicitly
non-confirmable. Applying a current mass-deletion quarantine is a separate
production data-rewrite decision: `POST` requires the bearer credential, a
unique `Idempotency-Key`, an evidence reason, and the exact
`apply:{snapshotId}:{fingerprint}` confirmation phrase. The server takes a
per-source lease, refetches a complete canonical source, and requires exact
source, board, fingerprint, count, and membership equality. A mismatch closes
nothing. On an exact match, only the frozen missing source observations may
close; canonical jobs with another open observation remain open. The closures,
source release, and durable application audit commit atomically. Because this
is closure-only review rather than full ingestion, it does not advance
`last_successful_at`; the next normal refresh ingests any additions. Scheduled
refresh skips a source while that lease is held.

## Canonical job identity and source observations

`jobs` contains one canonical opening while `job_observations` retains every
provider/source/external-ID observation that resolved to it. Resolution is
strictly ordered:

1. the same provider, source, and stable external job ID;
2. the same normalized canonical detail URL for the same canonical employer;
3. one unambiguous cross-source match for the same employer, exact normalized
   title and employment type, compatible location tokens, description-token
   similarity of at least 0.55, and publication dates within 14 days.

The third path considers only currently open jobs and rejects ties within 0.05.
Company name and title alone can never merge openings. URL normalization
lowercases the host, removes fragments/default ports/trailing slashes, sorts
query parameters, and removes only known tracking parameters.

Each observation preserves its original URL, evidence URL, fields, source
identity, parser/run provenance, timestamps, status, initial match method, and
match score. A clean source disappearance closes only that observation. The
canonical job remains verified open while any other verified observation is
active and closes exactly once after the last observation disappears. The
forward migration backfills every existing canonical job with a truthful
`backfill` observation without deleting or rewriting the canonical row.
Refreshes retain bounded concurrency across employers but serialize alternate
sources for one employer so the later source sees the earlier source's
committed identity decision.

## Job provenance and LinkedIn evidence state

Every canonical job stores `first_seen_at`, `last_seen_at`,
`source_updated_at`, `last_verified_at`, provider/source identity, raw and
canonical URLs, discovery channel, evidence URL, parser version, and snapshot
run ID. Existing rows are forward-migrated without changing their truth state;
their canonical URL becomes the raw/evidence URL and unknown historical
parser/run values remain explicitly `legacy` until reverified.

`linkedin_presence_state` is restricted to `confirmed`, `not_observed`, or
`unknown`. New canonical ATS observations default to `unknown` and refreshes
never overwrite independently collected LinkedIn evidence. `not_observed`
does not mean “not on LinkedIn”; it is meaningful only with a licensed evidence
URL and timestamp in `linkedin_evidence_url` and `linkedin_checked_at`.

## Off-board hiring signals

Off-board leads are stored in `hiring_signals`, never in `jobs`. The protected
`POST /api/internal/signals/import` accepts only identifiable employers, an
explicit role or function, current timestamped evidence, a documented
first-party/authorized/permitted source, an HTTPS rights reference, confidence,
and an expiry no more than 90 days after observation. The import is
all-or-nothing for validation and cannot create, update, or close a canonical
job.

Public `GET /api/v1/signals` returns only rows whose status is `active` and
whose expiry is still in the future. Expired records fall out at read time
without a cleanup write; records marked `unverifiable` or `promoted` also leave
the active result automatically. Coverage exposes `activeHiringSignals` as a
separate metric. It is never added to `verifiedOpenJobs`, and canonical refresh
does not read the signals table when deciding openings or closures.

The site presents these leads in a separate “Off the radar” section with source,
confidence, last-verification freshness, and expiry. No production signal is
seeded or fabricated. A signal may be promoted only after a current first-party
or authorized application path satisfies the canonical opening rules.

### Exact-role signal promotion

Protected `POST /api/internal/signals/promote` accepts one stable `signalId`.
It cannot promote an inactive or expired signal, a signal without a canonical
company, an employer-domain mismatch, or a source-kind claim whose host and
permission do not match its evidence class. Company blog and RSS evidence must
stay on the employer domain; GitHub and Hacker News use their named public
hosts; authorized APIs require `authorized`; submissions require `authorized`
or `manual_reviewed`.

For an eligible signal, the worker loads the company’s configured canonical
sources sequentially. It requires a complete current source response and
exactly one normalized role URL match among the signal’s source, evidence, and
application URLs. Known terminal application suffixes such as `/apply`,
`/application`, and Recruitee `/c/new` normalize to the corresponding detail
URL. Title or company name can never trigger promotion.

The complete matching source is persisted through the same snapshot,
quarantine, closure, observation, and deduplication path as a scheduled
canonical refresh. Only after that succeeds does a D1 batch write
`hiring_signal_promotions` and mark the signal promoted. The durable promotion
retains the original evidence URL, rights URL, source kind, exact canonical
job/source identity, verification time, and run ID. Retry after success returns
the existing job without another fetch. Failure or ambiguity writes no
promotion and leaves the lead outside verified-opening counts.

Public `GET /api/v1/off-board-openings` joins promotions only to currently open
canonical jobs. Coverage reports distinct `offBoardVerifiedOpenings` and
`offBoardVerifiedCompanies`; both remain subsets of canonical verified jobs,
never additions to `verifiedOpenJobs`. The UI displays this verified lane
separately from signals awaiting verification.

### Hacker News source-rights decision

Hacker News publishes an official, read-only Firebase API and documents v0
items, direct `kids`, users, and Ask-story lists. The API launch explicitly
directs API consumers away from HTML scraping. However, Y Combinator's current
site terms restrict automated data mining and commercial redistribution unless
expressly authorized. The API documentation does not clearly grant reuse of
user comments for this product, and the repository's MIT license covers the API
documentation and samples rather than HN user content.

Accordingly, Hacker News remains `awaiting_permission`: no automated collector
is implemented or scheduled, and HN comments are not copied into the database.
If permission is obtained, collection must use only the official API, direct
top-level comments in the current monthly “Who is hiring?” thread, bounded
requests, concise factual extraction without comment bodies or personal
contact details, and signal-only classification pending exact canonical
verification.

Official references:

- https://www.ycombinator.com/blog/hacker-news-api
- https://github.com/HackerNews/API
- https://www.ycombinator.com/legal/#terms

## Read-only production quality audit

`pnpm run audit:live-quality` selects a deterministic 200-record sample with at
least one record per represented company when the sample size permits. It loads
each corresponding canonical ATS collection once. A row is fresh only when its
stable source ID or normalized canonical URL remains in the current eligible
collection. For providers that expose raw publication observations, a role
that is still published but rejected by current eligibility rules is reported
as `ineligible`, not stale. A row is stale only when it is absent from both the
eligible and complete raw current collection. Unsupported or failed sources are
inconclusive and cannot improve the rate.

Exact duplicates require a repeated provider/board/external ID or normalized
canonical URL. Weaker same-title/location/employment clusters are review
candidates and never counted as duplicates automatically. The command is
read-only, can write a row-level JSON artifact with `--output`, and explicitly
leaves the completion contract's manual review outstanding. `--sample-size all`
audits the full returned inventory for a pre-deployment reconciliation forecast.

## First-party structured career pages

When a supported public ATS link is absent, discovery may inspect the
company's own HTTPS career surface. The adapter reads `JobPosting` JSON-LD
first and permits a conservative semantic fallback only when the page has a
title, explicit apply action, requisition ID, and US eligibility evidence.
Robots rules, redirects, response sizes, sitemap inputs, crawl depth, page
count, and per-domain concurrency are bounded.

These HTML sources are intentionally treated as fragile. A role remains open
after its first clean disappearance and closes only after a second complete
snapshot 24–48 hours later. Parser errors, incomplete crawls, and mass
disappearances are quarantined without closing roles.

The read-only live verifier can be run against an approved source with:

```sh
pnpm run verify:structured -- https://www.mozilla.org/en-US/careers/listings/
```

## Workable public account endpoint

Workable officially documents
`https://www.workable.com/api/accounts/{account_subdomain}?details=true` as an
alternate public endpoint for published jobs. The adapter retains the stable
account subdomain and Workable shortcode, requires a bounded complete JSON
collection, and requires each published row to provide a title, timestamp,
description, explicit location or remote state, canonical HTTPS Workable URL,
and HTTPS Workable application action.

The public endpoint emits one row per visible job location. Rows sharing a
shortcode are therefore one job, not independent openings. The adapter proves
that duplicate rows agree on title and canonical/action URLs, collapses them by
shortcode, and aggregates only their US locations for the US board. Explicit
draft, closed, archived, internal, or confidential lifecycle states are
rejected. The top-level `state` field may also contain a geographic state on
this public surface, so arbitrary non-`published` values are not treated as
lifecycle evidence.

Successful JSON is bounded to five megabytes. HTTP 429 and 5xx responses use
the shared bounded retry policy and honor `Retry-After`; production Workable
request starts are serialized at one per second, matching Workable's documented
ten-request-per-ten-second API limit. Only a complete validated collection can
close a missing shortcode, and the source-level mass-deletion guard remains in
force.

Workable's separately documented XML feed was evaluated and rejected for this
employer-scoped adapter. The XML file contains postings across all Workable
customers, cannot be filtered server-side, and includes only jobs separately
approved and published on Jobs by Workable. Its absence cannot prove that a
specific employer role has closed. A bounded read-only request also timed out
without receiving bytes, making the global feed unsuitable for the worker
refresh path.

The read-only real-source verifier is:

```sh
pnpm run verify:workable -- uncapped
```

On 2026-07-31 it observed eleven published location rows for Uncapped, verified
three unique current US roles, and successfully loaded all three application
actions. Nothing was written to D1.

Official contract:

- https://help.workable.com/hc/en-us/articles/4903195036183-Troubleshooting-API-issues
- https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page
- https://help.workable.com/hc/en-us/articles/115012801727-How-to-embed-jobs-on-your-website-job-widget
- https://help.workable.com/hc/en-us/articles/4420464031767-Utilizing-the-XML-Job-Feed

## Recruitee Careers Site API

Recruitee is an authoritative public ATS adapter. Its documented, unauthenticated
Careers Site API returns the complete collection of currently published offers
from `https://{company}.recruitee.com/api/offers/`. Detection stores the stable
tenant subdomain rather than an individual offer URL. A response is complete
only when every offer has a stable ID, published state, HTTPS detail URL, and
HTTPS application URL.

The adapter excludes general, speculative, and unsolicited application pools
because those are hiring signals rather than explicit openings. It retains
published US-eligible roles, canonical detail URLs, locations, work model,
employment type, salary, timestamps, and descriptions. HTTP 429 and 5xx
responses retry at most three times, honor `Retry-After` up to ten seconds, and
never treat an incomplete HTTP 200 response as absence.

The read-only real-source verifier is:

```sh
pnpm run verify:recruitee -- make
```

Official contract:

- https://docs.recruitee.com/reference/intro-to-careers-site-api
- https://docs.recruitee.com/reference/offers

## Personio career-site XML

Personio is an authoritative public ATS adapter. Personio documents the
employer-scoped `https://{tenant}.jobs.personio.{de|com}/xml?language=en` feed
as the current open positions published from that company's career site. The
feed is a complete collection rather than a paginated result, so the adapter
stores the full Personio hostname as its stable source identity.

The XML parser is bounded to two megabytes and accepts only the documented
`workzag-jobs` structure. It rejects DTD/entity declarations, malformed or
unexpected elements, duplicate position IDs, HTML/login responses, and
positions without an ID, title, office, or description collection. A rejected
HTTP-200 response is quarantined and cannot close an existing job.

Published US-eligible positions retain their stable ID, title, office,
department, descriptions, employment type, schedule, creation time, salary,
and canonical Personio detail URL using Personio's documented
`/job/{position-id}` integration pattern. General, speculative, unsolicited,
and `Initiativbewerbung` application pools are excluded. Because the validated
XML represents the complete current published set, a clean disappearance uses
the authoritative public-ATS closure path; the mass-deletion circuit breaker
still applies. The live verifier additionally requires every normalized detail
page to return successfully with an application action.

The read-only real-source verifier is:

```sh
pnpm run verify:personio -- cyted.jobs.personio.com
```

Official contract:

- https://developer.personio.de/v1.0/reference/get_xml
- https://developer.personio.de/docs/retrieving-open-job-positions
- https://developer.personio.de/docs/integration-of-open-positions
- https://support.personio.de/hc/en-us/articles/207576365-Integrate-jobs-from-Personio-into-your-website-via-XML

## SmartRecruiters Posting API

SmartRecruiters is an authoritative public ATS adapter. Its Posting API is a
documented no-auth public-data surface for published company postings. The
adapter stores the case-preserving company identifier from a
`jobs.smartrecruiters.com` or `careers.smartrecruiters.com` URL and reads the
employer-scoped `/v1/companies/{companyIdentifier}/postings` collection.

Collection proof is fail-closed: every page must have the requested offset, a
valid limit, a stable `totalFound`, unique posting IDs, and documented company,
location, visibility, timestamp, UUID, and detail-reference fields. It collects
the full result set before requesting US-eligible details. Collection is bounded
to 20 pages and 2,000 postings; list bodies are bounded to five megabytes and
detail bodies to two megabytes.

Every eligible detail must match its list identity and company, remain active
and public, and expose HTTPS posting and application actions plus a job
description. General applications and talent pools are excluded. Only after all
pages and eligible details validate can absence close a prior role; schema
drift, count drift, malformed JSON, incomplete pages, and exhausted requests
quarantine the snapshot. A source request retries at most three times for
network failures, HTTP 429, and 5xx responses. `Retry-After` is capped at ten
seconds, request starts are paced to eight per second, and detail concurrency is
four, within the documented 10-request/second and eight-concurrent limits.

The read-only real-source verifier is:

```sh
pnpm run verify:smartrecruiters -- Nexthink
```

On 2026-07-30 it observed all 93 published Nexthink postings and verified 32
current US roles with application actions. Nothing was written to D1.

Official contract:

- https://developers.smartrecruiters.com/docs/authentication
- https://developers.smartrecruiters.com/docs/customer-overview
- https://developers.smartrecruiters.com/docs/endpoints
- https://developers.smartrecruiters.com/docs/throttling-policies
- https://developers.smartrecruiters.com/reference/v1getposting
