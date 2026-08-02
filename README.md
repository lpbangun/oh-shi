# OH SHI

OH SHI is the Operational Headquarters for Startup Hiring Intelligence: a public, lightweight source of truth for startup companies, hiring signals, canonical job status, and recent changes.

It is designed for both people and AI agents. Humans get a fast searchable job board. Agents get stable JSON, JSONL, incremental change feeds, evidence URLs, and explicit `verified_open` / `verified_closed` states.

## Local development

Requirements: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
pnpm quality
```

To exercise protected ingestion locally, start the development runtime with a
throwaway token, then send the same value as a bearer credential:

```bash
INGEST_TOKEN=local-only-token pnpm dev
```

The app uses Cloudflare D1 through the Sites runtime. The database initializes with
12 source-verified companies across a normalized sector taxonomy. A bounded
two-hour discovery and canonical-refresh run then expands coverage and replaces
seed hiring facts with current ATS records. A separate daily run scans tracked
companies' official pages plus TechCrunch Venture and Crunchbase News for
definitive, dated funding announcements.

## Evaluation gate

`pnpm quality` runs the local release gate in order:

1. strict TypeScript validation;
2. data-integrity, normalization, agent-contract, and product-hygiene evals;
3. the production build.

The build does not run if an earlier criterion fails. `pnpm eval:live` separately verifies the deployed public site and API contracts. The complete criteria are documented in `evals/CRITERIA.md`.

`pnpm quality:ci` adds lint and Playwright coverage for desktop, 320px mobile,
keyboard navigation, reduced motion, pagination, agent contracts, and accessibility.
The push/PR workflow also performs a frozen install and rejects high-severity
production dependency advisories.

## Public interfaces

- `GET /api/v1/intelligence` (preferred; capability discovery)
- `GET /api/v1/intelligence?view=jobs|companies|movements|sectors`
- `GET /api/v1/companies` (compatibility)
- `GET /api/v1/companies/:id`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `GET /api/v1/changes`
- `GET /api/v1/coverage`
- `GET /api/v1/signals`
- `GET /api/v1/off-board-openings`
- `GET /exports/companies.jsonl`
- `GET /exports/jobs.jsonl`
- `GET /exports/daily-changes.json`
- `GET /llms.txt`

Pass `?include_closed=true` to the jobs endpoint to retain closed history.
The preferred intelligence endpoint validates filters, returns HTTP 400 for unknown
parameters, and provides deterministic cursor pagination. See `/llms.txt` for exact
filters and natural-language request recipes. Default job results use the same
deterministic company-diverse ranked round-robin order in the preferred API,
compatibility API, and human interface.

## Discovery and refresh

`POST /api/internal/refresh` first attempts every configured investor source,
promotes up to 150 permitted domains from the registry onto the discovery queue,
processes at most 30 discovery candidates, activates at most 25 companies after
canonical verification, and then rechecks active Ashby, Greenhouse, Lever, and
supported Workable sources. It upserts live roles, records new openings, and
marks roles absent from a successful complete response from the same source as
closed. It requires `Authorization: Bearer <INGEST_TOKEN>`.

Candidates reach the queue from two places: the investor-portfolio crawl, and
promotion from the startup domain registry. Registry promotion ranks
directory-sourced domains first because an entry that exists to describe a
startup detects a board far more often than an encyclopedia entry that merely
mentions a company.

A candidate's board is resolved by crawling its official site for a link to a
supported ATS. When that finds nothing — the common case for a client-rendered
or bot-protected careers page — discovery falls back to probing the public
Greenhouse, Lever, and Ashby board APIs by slug. A Greenhouse match must be
corroborated by the board's own published employer name, and a Lever or Ashby
match must use a slug equal to the registrable-domain label, so a slug
collision cannot activate the wrong employer.

The included GitHub Actions workflow runs at minute 30 every two hours. It first
syncs the public startup directory into the domain registry
(`scripts/sync-startup-directory.ts`, evidence only — it never activates a
company), then runs the refresh. It needs these repository settings:

- variable `OH_SHI_BASE_URL`
- secret `OH_SHI_INGEST_TOKEN`

The daily funding workflow runs at 11:20 UTC and calls the protected,
idempotent `POST /api/internal/funding/refresh` endpoint. A candidate is
published only when it names a tracked company, states a completed raise (not a
rumor or planned round), carries a publication date within the last 14 days,
and links to HTTPS evidence on the company's own domain or one of the explicit
reputable publications. Publishing writes a standalone `funding_announced`
movement, updates only newer company funding facts, and recomputes the affected
company's hiring-signal and evidence-confidence receipts immediately. Replays
cannot duplicate an announcement or roll funding facts backward.

The same bearer credential protects `POST /api/internal/discovery/import`, the
licensed/manual intake for sources where automated discovery is not permitted.
See [docs/discovery-sources.md](docs/discovery-sources.md) for source policy,
access status, limits, and the import record shape.

Manual review uses the same workflow with `mode=stage_review`. It assigns up to
500 candidates to a durable private batch, scans them in resumable groups of 25,
and uploads JSON plus candidate/job CSV artifacts. Assigned candidates are
excluded from scheduled activation until their exact IDs and staged board
fingerprints are approved with `mode=approve_review`. Approval re-fetches each
canonical board and fails closed if its job membership changed. Staging never
creates a company, enables a source, or publishes a job.

`pnpm run pilot:measure-yield` with `--offset=0`, `--limit=25`, and an explicit
`--as-of=2026-07-31T00:00:00.000Z` performs a local, read-only, resumable
measurement over the ignored 500-domain pilot artifact. It writes
input/config/implementation-bound JSONL receipts and a derived summary under
`outputs/`; it never imports candidates, activates companies, writes D1, or
fetches an unsupported external career host. Reuse the same explicit `as-of`
value and output paths when resuming. A receipt/config mismatch fails closed
and requires a new receipts path.

`pnpm run audit:live-quality` performs a read-only deterministic 200-record
sample against the deployed jobs API and the corresponding complete canonical
ATS collections. Use `--output <path>` to retain the row-level review artifact.
Use `--sample-size all` for a full-inventory dry run.
The automated audit distinguishes closed records, still-published records that
fail current eligibility rules, exact duplicates, and inconclusive source
failures. It does not replace the final manual review required for release.

Mass-deletion quarantine inspection and application are deliberately separate
from refresh. The protected snapshot `GET` is read-only. Its `POST` path
requires its own explicit production data-rewrite approval and revalidates an
exact frozen member set against a fresh complete source before any closure.
Deploying or triggering refresh does not authorize applying a quarantine.

## Database and release operations

`drizzle/0001_discovery_pipeline.sql` is an additive, forward-only D1 migration.
The runtime also applies the same idempotent `CREATE TABLE`, `CREATE INDEX`, and
safe column additions before reading data, so an existing Sites D1 binding can
upgrade without dropping records. A release operator should:

1. preserve the existing Sites project and `DB` binding;
2. configure the deployment secret `INGEST_TOKEN`;
3. deploy the saved source version;
4. call `GET /api/v1/coverage` and confirm existing counts remain present; and
5. trigger the refresh workflow once, then confirm its freshness receipt; and
6. inspect any mass-deletion quarantines read-only, then obtain separate
   approval before applying one.

No third-party API key is required for the public ATS adapters. Sources that
require permission or a licensed feed remain in manual status instead of being
scraped.

## Signal policy

`hiringScore` is a directional 0-100 hiring-momentum score. It is **not** a probability and has not been calibrated against hiring outcomes, so it must not be read as "an N% chance of hiring." It is recomputed on every refresh by `computeHiringScore` in `lib/hiring-score.ts` from four published components:

| Component | Max | Input |
| --- | --- | --- |
| Open-role volume | 30 | Verified-open roles, log-saturating at 12 |
| Open-role growth | 30 | Net opens minus closes over the trailing 90 days, saturating at ±6; a board with no observed activity scores 9 |
| Funding and stage | 25 | Stage weight (Pre-seed 0.5, Seed 0.6, A 0.8, B 0.9, C 0.95, D+ / Growth 1.0) times funding recency (full ≤180 days, decaying to 0.4 at 540 days, 0.6 when the funding date is unknown) |
| Board freshness | 15 | Days since the canonical board was last verified: full ≤2 days, reaching 0 at 30 days |

`evidenceConfidence` is a separate 0-100 score measuring how well-evidenced the record is, not how attractive the company is: verification recency (40), share of open roles re-verified in the latest refresh (30), record completeness (20), and an independent-source check where the company domain differs from the careers domain (10).

Both scores are deterministic functions of stored data and carry no hand-tuning per company. Companies whose canonical board is not in the refresh list are still rescored, and their board-freshness and verification-recency components decay over time. Historical outcomes should be used to calibrate the model before investor identity affects the score.

## Licensing and source rights

Software is MIT licensed. Project-authored documentation and factual exports are offered under CC BY 4.0. This does not relicense third-party job descriptions, logos, posts, or source content. OH SHI stores concise factual fields and links users to canonical sources.
