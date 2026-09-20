import { conditionalResponse } from "@/lib/conditional-cache";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const body = `# OH SHI - Startup Hiring Intelligence

OH SHI, the Operational Headquarters for Startup Hiring Intelligence, is a public source of startup hiring facts for humans and AI agents.

## Freshness, sectors, and scoring
Canonical ATS and permitted first-party career sources are refreshed every two hours.
Industry labels remain as sourced and are also normalized into a stable public sector
taxonomy for filtering, aggregation, and movement views. When an industry is missing,
high-confidence company and domain context can provide the sector; records without a
reliable signal are returned as sector Other. Funding discovery is a separate daily
process. The /exports/daily-changes.json compatibility surface is a daily changes
export and does not mean canonical jobs refresh only once per day.

Hiring signal is a directional 0–100 measure of observed hiring momentum, not a
probability or calibrated forecast. Its components are open-role volume (0–30),
90-day net role growth (0–30), funding stage and recency (0–25), and canonical-board
freshness (0–15). Evidence confidence is separate and measures evidence quality:
verification recency (0–40), canonical-board coverage (0–30), company-record
completeness (0–20), and independent-source corroboration (0–10).
The 30-day change is roles opened minus roles closed from the change feed during the
last 30 days; no events in that window is reported as flat.

## Preferred entrypoint
- Intelligence capabilities: ${origin}/api/v1/intelligence
- Jobs: ${origin}/api/v1/intelligence?view=jobs
- Companies: ${origin}/api/v1/intelligence?view=companies
- Market movements: ${origin}/api/v1/intelligence?view=movements
- Sector totals: ${origin}/api/v1/intelligence?view=sectors
- Coverage and freshness: ${origin}/api/v1/coverage
- Verified off-board openings: ${origin}/api/v1/off-board-openings
- Off-board hiring signals: ${origin}/api/v1/signals
- Edtech pack jobs (compact, count-first): ${origin}/api/v1/agent/jobs

Call the capabilities URL first. It lists every supported filter. Unknown filters,
invalid values, and malformed cursors return HTTP 400 rather than silently returning
unfiltered data. Pass page.next_cursor unchanged with the same view and filters.
Company pages default to 10 records; movement pages default to 25.
Default job results use one shared deterministic company-diverse ranked
round-robin order across the browser, preferred API, and compatibility API.
Job queries default to status=verified_open, execute in D1, and return page.total
for the complete matching dataset. Supported job sorts are signal, title,
title_desc, company, company_desc, sector, dept, loc, comp_low, comp_high,
recent, and oldest; every order has a stable job-id tie-breaker.
The q parameter also accepts deterministic natural-language job requests. It can
resolve role aliases, remote/hybrid/on-site arrangements, employment types, company
phrases, locations, and relative date phrases such as "this week". Resolved values
are returned in applied_filters. Explicit filters override values inferred from q.
Canonical employment_type values are Full time, Part time, Contract, Temporary, and
Internship; common aliases such as full-time, contractor, temp, and intern are accepted.
Canonical role_family values are People operations, GTM, Operations,
Data and research, Engineering, Product, and Other. The aliases people and
people_operations map to People operations; call the capabilities endpoint for
the complete alias map. Unknown role families return HTTP 400.
The compatibility /api/v1/jobs endpoint is bounded to 100 records per response
(100 by default). Use its cursor or, preferably, the incremental flow below; do
not plan for a whole-dataset response.
The after movement filter is exclusive; use the exact ISO-8601 boundary you want
excluded.

Capability availability is live data, not a promise that a configured surface
currently contains records. Read data.capabilityAvailability from /api/v1/coverage
or data.availability on the signal endpoints. An unavailable investor filter has
no published permitted relationships and will return no matches; dormant means a
pipeline is configured but currently publishes zero qualifying records.
Stable public representations include an ETag. Send If-None-Match with the saved
ETag; an unchanged representation returns HTTP 304 without retransmitting its body.
Coverage also separates the discovery registry from the operational queue in
data.discoveryFunnel. The registry's eligibleForPromotion and permissionExcluded
reconcile to promotionUniverse; the queue's autoEligible and permissionExcluded
reconcile to queue.total. Permission-excluded candidates are never fetched
automatically. eligibleNeverQueued and eligibleQueued partition permitted registry
work. readyToProcess mirrors permission, review, version, and retry-time gates;
reviewGated, retryDue, and retryDeferred expose held work. queue.outcomes contains
normalized outcomes only for auto-eligible candidates, while needsReviewReasons retains bounded
operator diagnostics without exposing company or domain identities.
Protected operator review is an explicit manual workflow and is not the automatic
discovery processor.

## Natural-language request recipes
- "Open remote Operations jobs":
  ${origin}/api/v1/intelligence?view=jobs&status=verified_open&role_family=Operations&remote_status=Remote
- "High-confidence companies in Healthcare":
  ${origin}/api/v1/intelligence?view=companies&sector=Healthcare&min_confidence=80
- "What changed at Cognition since July 1, 2026?":
  ${origin}/api/v1/intelligence?view=movements&company=cognition&after=2026-07-01T00%3A00%3A00Z
- "Which sectors are gaining roles?":
  ${origin}/api/v1/intelligence?view=sectors
- "Funding movements, ten at a time":
  ${origin}/api/v1/intelligence?view=movements&type=funding&limit=10
- "Bundle openings by sector and day":
  ${origin}/api/v1/intelligence?view=movements&group=sector_day&type=opened

Responses use camelCase record fields. Each envelope includes schema_version,
generated_at, data_as_of, applied_filters, page, methodology_version, license, and
data. Company records include signal and confidence calculation receipts. Movement
records include underlying jobs, stable record IDs, and source URLs.
Funding movements use a separate daily discovery process, remain standalone company
movements, and always include a navigable official-company or reputable-publication source URL.
The affected company's directional score is recomputed when newer funding is published.

## Incremental job synchronization
1. Run an initial jobs query and store its incremental.after value together with
   your search filters. That value is captured before the query, so a concurrent
   change may be replayed but cannot be skipped.
2. Call incremental.changes_url. The feed is ordered by the exclusive tuple
   (occurredAt, id), returns at most 100 events, and supplies page.next_cursor.
3. Pass that cursor unchanged as /api/v1/changes?cursor=... until page.has_more is
   false. Persist the returned cursor only after durably applying the whole page.
4. For job_opened, job_updated, and job_closed, fetch /api/v1/jobs/:entityId and
   re-evaluate the original filters. Insert/update a matching record; remove it from
   that filtered result when it no longer matches. Closed jobs remain fetchable.

Retries are safe: replay the same cursor until the whole page commits locally and
deduplicate by event id. Events that share occurredAt are not skipped because id is
part of the checkpoint. HTTP 410 checkpoint_expired means retained history no longer
covers the checkpoint; discard the local checkpoint, run a fresh initial jobs query,
and resume from its new incremental.after value.

Timestamp meanings: firstSeenAt is Oh Shi's first observation; lastSeenAt is the most
recent complete source observation; sourceUpdatedAt is a source-provided update time
when available; lastVerifiedAt is Oh Shi's successful canonical verification time;
closedAt is the confirmed closure time; occurredAt is the event observation time.

## Edtech pack agent jobs
- Compact board-scoped jobs: ${origin}/api/v1/agent/jobs
- Required boards filter: boards=coursera,duolingo or repeated boards=
- Optional title filters: titles=curriculum,account%20executive or repeated titles=
- Optional role_family uses the same canonical families as /api/v1/intelligence
- Responses put count first, then schema_version, generated_at, applied_filters,
  and jobs. Compact rows use camelCase, stable ids, canonicalUrl, and applyUrl on
  the employer ATS. Posting description/body is omitted by default.
- Only requested board ids are returned; unrequested boards are excluded.
- Empty boards or zero matches return HTTP 200 with count=0 and jobs=[].
- Unknown parameters or invalid board syntax return HTTP 400.
- Example:
  ${origin}/api/v1/agent/jobs?boards=coursera,duolingo&titles=curriculum,software%20engineer
- Incremental receipt: use incremental.changes_url (/api/v1/changes) for canonical
  OH SHI job synchronization. Edtech pack rows remain compact in the change feed.

## Compatibility and bulk endpoints
- Companies: ${origin}/api/v1/companies
- Jobs: ${origin}/api/v1/jobs
- Changes: ${origin}/api/v1/changes
- Coverage: ${origin}/api/v1/coverage
- Verified off-board openings: ${origin}/api/v1/off-board-openings
- Off-board hiring signals: ${origin}/api/v1/signals
- Edtech pack jobs: ${origin}/api/v1/agent/jobs
- Company JSONL: ${origin}/exports/companies.jsonl
- Job JSONL: ${origin}/exports/jobs.jsonl
- Daily changes export: ${origin}/exports/daily-changes.json

Job states are verified_open or verified_closed; collection queries default to open.
Treat canonicalUrl as the
application source. Job provenance includes rawUrl, evidenceUrl, discoveryChannel,
parserVersion, snapshotRunId, firstSeenAt, lastSeenAt, sourceUpdatedAt, and
lastVerifiedAt. linkedInPresenceState is confirmed, not_observed, or unknown;
not_observed is not a claim that a role is absent from LinkedIn and must be
interpreted only with its evidence URL and check timestamp.
Job records retain summary as a short preview. description contains the normalized
canonical posting body when stored; descriptionAvailable reports whether it is
present, descriptionUrl is the canonical fallback, and summaryTruncated prevents
consumers from treating the preview as complete scoring evidence.
Hiring signal is a directional momentum score, not a probability.
Evidence confidence measures source completeness and verification freshness.
Off-board hiring signals are a separate, expiring evidence class. They are not
verified openings, never contribute to verified-open counts, and never influence
canonical closure. Use only the unexpired records returned by /api/v1/signals.
Off-board verified openings are canonical jobs discovered through permitted
off-board evidence and re-verified by exact role URL on a complete current
employer or documented public-ATS source. They remain part of the canonical job
count and are listed with their original evidence at /api/v1/off-board-openings.
Software license: MIT. Project-owned factual exports: CC BY 4.0. Third-party source rights remain with their owners.
`;
  return conditionalResponse(request, body, {
    contentType: "text/plain; charset=utf-8",
    cacheControl: "public, max-age=3600",
    validator: body,
  });
}
