# Discovery source policy

Last reviewed: 2026-07-28.

Investor and accelerator pages are discovery evidence only. OH SHI publishes a
job only after a successful, complete fetch from the employer's Ashby,
Greenhouse, Lever, or supported Workable board. Glassdoor, LinkedIn, X, and
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
| 2 | General Catalyst | https://www.generalcatalyst.com/portfolio | https://jobs.generalcatalyst.com/jobs | Public page |
| 3 | Khosla Ventures | https://www.khoslaventures.com/portfolio | https://jobs.khoslaventures.com/jobs | Awaiting permission / manual import |
| 4 | Sequoia Capital | https://sequoiacap.com/our-companies/ | https://jobs.sequoiacap.com/jobs | Public page |
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

General Catalyst and Sequoia are the only initial sources enabled for automatic
public-page discovery after the terms/robots review. Khosla and Accel have no
clear automation permission; NEA restricts copying for commercial use;
Lightspeed prohibits robots and scraping; Bessemer prohibits screen/database
scraping; Insight prohibits robots, scrapers, and crawlers; and Y Combinator's
official legal terms prohibit scraping site content. Those eight sources remain
configured and attempted as manual/permission statuses, but are not fetched.

No documented general-purpose portfolio API was found in the official
resources during this review. The public-page mechanism therefore extracts
only explicit outbound HTTPS links and places them in a reviewable queue.
Candidates are deduplicated by normalized domain. Onboarding then resolves the
employer website, detects a supported ATS, and requires a complete canonical
fetch containing at least one US-eligible open role.

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
