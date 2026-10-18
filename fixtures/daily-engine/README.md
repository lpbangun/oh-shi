# Daily engine round 2 — FIXTURES, not live discovery

Both corpora describe the same synthetic companies/events. Direct input uses
HTML funding pages plus a SPARQL binding; TinyFish input uses Search leads
mapped to Fetch documents. Neither fixture adapter makes external requests.
All .example names, funding headlines, and the synthetic Wikidata item are
test data, not claims about real companies. The Vanta fixture is also synthetic.

## Reproduce ($0, local only)

Run from the candidate worktree:

```sh
node scripts/run-daily-engine.mjs
node scripts/run-daily-engine.mjs --lane direct --fixtures fixtures/daily-engine/direct --out outputs/lane-a
node scripts/run-daily-engine.mjs --lane tinyfish --fixtures fixtures/daily-engine/tinyfish --out outputs/lane-b
node scripts/build-comparison.mjs
node scripts/run-daily-engine.mjs --list --out outputs/lane-a
node scripts/run-daily-engine.mjs --lane direct --fixtures fixtures/daily-engine/direct --dry-run --out outputs/dry-run
node scripts/run-daily-engine.mjs --lane tinyfish --out outputs/tinyfish-blocked
pnpm run typecheck
pnpm run eval
```

Open outputs/comparison/comparison.html directly. It is self-contained; receipt
links are relative to retained exports. JSON is beside it. --lookback-days
defaults to 14. The generator refuses different revisions, rules, or baselines.

The CLI default is a safe direct fixture run. TinyFish without --fixtures
returns LIVE-BLOCKED and zero calls. --live cannot enable collection this round.
No scheduler, production database, investor directory, or paid endpoint is used.
The direct live implementation is callable only through its adapter, not the CLI.
The TinyFish live adapter is a configurable, unvalidated Search/Fetch transport;
the CLI also blocks it if configuration becomes available. Provider endpoint,
auth and response contracts must be confirmed before any future live run.

## Local consumer and recovery

outputs/lane-a/d1 is a persistent Miniflare D1 database, isolated from lane B.
The store reuses db/schema.ts companies shape and Drizzle readback.
listDailyCompanies is the local public-consumer data-layer function; it
does not require jobs. Zerojobs (zero open jobs) appears with two funding events.
Unknown-HQ Cloudlead is retained pending but not exposed as a verified company.
The existing web app/remote DB is intentionally not connected to this local store.

Every completed source commits rows/events plus its source snapshot in one D1
transaction. Snapshots are scoped to engine version, revision, lane, baseline,
input, observation time and lookback. Identical replay adds zero rows/events;
failed sources retry next run, and recovered sources gain checkpoints.
For interruption evidence, run with --stop-after-sources 2 in a fresh --out
directory (expected exit 1), then repeat without that flag; the completed source
is reused without duplicate inserts. Live request retries are deliberately zero;
all calls have finite timeouts and global caps (100 total, 40 Search, 30 minutes).

Dry-run writes reports/exports as receipts, but does not open or mutate D1,
including its schema/checkpoints. Local report files are not database persistence.

## Frozen baseline provenance and limitations

baseline.json is the unchanged mission export:
ohshi-daily-discovery-20261018/baseline/baseline.json, captured read-only
2026-10-18. BASELINE-CAPTURE.md records production schema divergence:
companies/startup_domains were absent. The available baseline comprises
120 board_sources employer domains (127 rows, 7 unparsed) plus 12 repo seeds.
ATS-only employers without employer domains may be absent. Historical novelty
is UNKNOWN-limited, never measured zero; only absence from this limited baseline
can be counted mechanically. No fresh production access was made this round.

## Evidence and limits

Search results and news are leads, not HQ evidence. HQ requires explicit
first-party country text, or Wikidata P159/P17; customers, USD and offices do
not verify HQ. Country parsing is intentionally conservative: unrecognized
locations stay unknown. Funding requires a permitted official/reputable fetched
document, company attribution and explicit funding-action language. Speculation
is excluded. Missing dates remain evidence gaps; no amount or stage is invented.
Announced/completed are distinct. Recent comparison counts use dated funding
on US-HQ-verified companies only. Undated and pending events remain inspectable.
No-date events may be verified as undated announcements, never as recent funding.

The small synthetic sample tests mechanics, not real discovery yield or provider
quality. Cost is UNKNOWN (not measured); zero requests means local fixtures,
not a free live acquisition claim. Live A/B yield comparison is blocked:
scoped TinyFish free Search + Fetch configuration is absent; shared baseline OK.
Required environment configuration (no secret-file probing): TINYFISH_API_KEY,
TINYFISH_SEARCH_URL, TINYFISH_FETCH_URL. Never use Browser/Agent/Monitor URLs.
A provider contract/permission review and a frozen exact source/query plan are
also required before live collection. Verdict: inconclusive; no forced winner.
