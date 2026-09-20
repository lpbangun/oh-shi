# Edtech ingest snapshot diff (live-path demonstration)

Generated: 2026-09-20T01:48:13.304Z

This documents an honest two-run ingest diff on **coursera** and **duolingo** boards. Live boards do not churn within minutes, so the prior snapshot was deliberately perturbed before the second run:

1. **Run 1 (fresh):** `pnpm ingest:edtech --boards=coursera,duolingo --fresh --output=/tmp/edtech-ingest-diff`
2. **Perturb prior:** removed one live Coursera job (`6120396004`) and injected synthetic `verified_open` job `9999999001` at `https://boards.greenhouse.io/coursera/jobs/9999999001`.
3. **Run 2 (resume):** `pnpm ingest:edtech --boards=coursera,duolingo --output=/tmp/edtech-ingest-diff` (no `--fresh`; `loadPreviousEdtechSnapshot` reads newest `edtech-ingest-*.json`).

## Command output (run 2)

```json
{
  "success": 2,
  "quarantined": 0,
  "failed": 0,
  "openJobs": 42,
  "receipts": [
    {
      "board_id": "coursera",
      "status": "success",
      "observed": 6,
      "opened": 1,
      "closed": 1,
      "updated": 0
    },
    {
      "board_id": "duolingo",
      "status": "success",
      "observed": 36,
      "opened": 0,
      "closed": 0,
      "updated": 0
    }
  ]
}
```

## Interpretation

| Board | Opened | Closed | Notes |
| --- | ---: | ---: | --- |
| coursera | 1 | 1 | Re-opened removed live job `6120396004`; closed synthetic `9999999001` absent from live board |
| duolingo | 0 | 0 | Unchanged between runs |

Live jobs on both boards remained `verified_open` / quarantine-safe; only the synthetic extra job was closed.

Trimmed offline fixture: `evals/fixtures/edtech-ingest/snapshot-diff-receipts.json`.
