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

The app uses Cloudflare D1 through the Sites runtime. The database initializes with a small verified pilot dataset on first request.

## Evaluation gate

`pnpm quality` runs the release gate in order:

1. strict TypeScript validation;
2. data-integrity, normalization, agent-contract, and product-hygiene evals;
3. the production build.

The build does not run if an earlier criterion fails. `pnpm eval:live` separately verifies the deployed public site and API contracts. The complete criteria are documented in `evals/CRITERIA.md`.

## Public interfaces

- `GET /api/v1/companies`
- `GET /api/v1/companies/:id`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `GET /api/v1/changes`
- `GET /exports/companies.jsonl`
- `GET /exports/jobs.jsonl`
- `GET /exports/daily-changes.json`
- `GET /llms.txt`

Pass `?include_closed=true` to the jobs endpoint to retain closed history.

## Daily refresh

`POST /api/internal/refresh` rechecks configured canonical Ashby boards, upserts live roles, records new openings, and marks roles absent from their canonical board as closed. It requires `Authorization: Bearer <INGEST_TOKEN>`.

The included GitHub Actions workflow runs daily when these repository settings exist:

- variable `OH_SHI_BASE_URL`
- secret `OH_SHI_INGEST_TOKEN`

## Signal policy

The 90-day hiring probability is directional, not a guarantee. Early scores are transparent heuristics based on stage, funding recency, career-board activity, open-role growth, and evidence confidence. Historical outcomes should be used to calibrate the model before investor identity affects the score.

## Licensing and source rights

Software is MIT licensed. Project-authored documentation and factual exports are offered under CC BY 4.0. This does not relicense third-party job descriptions, logos, posts, or source content. OH SHI stores concise factual fields and links users to canonical sources.
