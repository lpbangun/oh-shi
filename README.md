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

The app uses Cloudflare D1 through the Sites runtime. The database initializes with
12 source-verified companies across a normalized sector taxonomy, then the canonical
daily refresh replaces seed hiring facts with current Ashby board records.

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
- `GET /exports/companies.jsonl`
- `GET /exports/jobs.jsonl`
- `GET /exports/daily-changes.json`
- `GET /llms.txt`

Pass `?include_closed=true` to the jobs endpoint to retain closed history.
The preferred intelligence endpoint validates filters, returns HTTP 400 for unknown
parameters, and provides deterministic cursor pagination. See `/llms.txt` for exact
filters and natural-language request recipes.

## Daily refresh

`POST /api/internal/refresh` rechecks configured canonical Ashby boards, upserts live roles, records new openings, and marks roles absent from their canonical board as closed. It requires `Authorization: Bearer <INGEST_TOKEN>`.

The included GitHub Actions workflow runs daily when these repository settings exist:

- variable `OH_SHI_BASE_URL`
- secret `OH_SHI_INGEST_TOKEN`

## Signal policy

`hiringScore` is a directional 0-100 hiring-momentum score. It is **not** a probability and has not been calibrated against hiring outcomes, so it must not be read as "an N% chance of hiring." It is recomputed on every refresh by `computeHiringScore` in `lib/hiring-score.ts` from four published components:

| Component | Max | Input |
| --- | --- | --- |
| Open-role volume | 30 | Verified-open roles, log-saturating at 12 |
| Open-role growth | 30 | Net opens minus closes over the trailing 90 days, saturating at ±6; a board with no observed activity scores 9 |
| Funding and stage | 25 | Stage weight (Seed 0.6 → Growth 1.0) times funding recency (full ≤180 days, decaying to 0.4 at 540 days, 0.6 when the funding date is unknown) |
| Board freshness | 15 | Days since the canonical board was last verified: full ≤2 days, reaching 0 at 30 days |

`evidenceConfidence` is a separate 0-100 score measuring how well-evidenced the record is, not how attractive the company is: verification recency (40), share of open roles re-verified in the latest refresh (30), record completeness (20), and an independent-source check where the company domain differs from the careers domain (10).

Both scores are deterministic functions of stored data and carry no hand-tuning per company. Companies whose canonical board is not in the refresh list are still rescored, and their board-freshness and verification-recency components decay over time. Historical outcomes should be used to calibrate the model before investor identity affects the score.

## Licensing and source rights

Software is MIT licensed. Project-authored documentation and factual exports are offered under CC BY 4.0. This does not relicense third-party job descriptions, logos, posts, or source content. OH SHI stores concise factual fields and links users to canonical sources.
