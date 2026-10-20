# Local announcement scheduling tick (inert by default)

This is a single executable **local/offline dry-run** tick over captured input, not
an unattended collector, Worker scheduled handler, cron registration, publication
path or production activation. No fetcher or remote DB option is added.

Default: `node scripts/run-announcement-pipeline.mjs --schedule-tick --out "$TMPDIR/tick-disabled"`
returns `status: disabled`, `ran: false`; it does not read input or open a store.
`--schedule-plan` remains descriptive only.

Explicit execution (use a fresh output directory for each invocation):

```sh
node scripts/run-announcement-pipeline.mjs \
  --schedule-tick --schedule-local-dry-run --dry-run --no-network \
  --input /absolute/path/to/captured-input.json --out "$TMPDIR/tick-due" \
  --now 2026-10-20T00:31:48Z --max-announcements 25
```

A due tick executes the same announcement intake/verification engine as the ordinary
CLI, with no persistence. `run-report.json` describes verification results;
`schedule-tick.json` records whether the engine ran, its bounded limit, and the next
eligible attempt (24 hours later). `status: ran` does **not** mean any record passed
verification; inspect the run report. A skipped tick writes only the tick receipt;
any old run report in a reused directory is not evidence for that invocation.

Pass the returned `nextAttemptAt` as `--next-attempt-at` to the next invocation.
A future timestamp gives `not_due`; equality is due. Optional
`--schedule-lease-active --last-attempted-at <ISO time>` models a resolving lease:
only a lease strictly older than the shared discovery one-hour cutoff is reclaimable.
Missing last-attempt time follows the existing discovery stale-lease rule. These are
caller-supplied snapshot controls, **not a durable/atomic multi-process claim store**.
The existing D1 scheduler retains its atomic claim; this local one-shot dry-run does
not mutate that queue, and must not be used as a production concurrency mechanism.

The tick shares `boundedDiscoveryScheduleLimit` / `DISCOVERY_SCHEDULE_MAX_ITEMS`
with D1 discovery selection, and due/lease policy with discovery's runnable/claim
controls. Limits clamp at 25; zero skips work. Negative, fractional and non-finite
CLI limits refuse. Input exceeding the effective tick limit refuses rather than
silently dropping announcements. Ordinary intake validation remains unchanged.
Enabled ticks require explicit `--dry-run --no-network`; persistence/store options,
`--activate`, `--live`, and network options refuse. No background work is scheduled.

## Evidence trust and authority boundaries

Captured SHA-256 proves **integrity of the captured bytes**, not authenticated origin
or that a claimed grant was actually issued. Fabricated but internally consistent
capture/evidence bytes can pass offline validation. This trust-on-capture limitation
applies to every reuse basis; no signature or provenance service is implied.

Narrow local facts-only reuse was independently assessed `PASS_QUALIFIED`; that is
not a publication license or general source clearance. Publication remains blocked.
Production novelty remains `BLOCKED/UNKNOWN` without authoritative production DB
binding/baseline; an absent domain in a public export is not proof of novelty.

The research report's no-time-element assertion is wrong: the captured raw article
contains `<time dateTime="2026-10-16">`. That date is valid and parsed by the existing
pipeline. Research history is preserved, not rewritten.

Production acquisition, durable scheduling, source/publication permissions, correct
production binding, write/deploy and explicit activation authority all remain separate
release prerequisites. Nothing in this local tick grants any of them.
