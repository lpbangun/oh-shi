export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const body = `# OH SHI - Startup Hiring Intelligence

OH SHI, the Operational Headquarters for Startup Hiring Intelligence, is a public source of startup hiring facts for humans and AI agents.

## Preferred entrypoint
- Intelligence capabilities: ${origin}/api/v1/intelligence
- Jobs: ${origin}/api/v1/intelligence?view=jobs
- Companies: ${origin}/api/v1/intelligence?view=companies
- Market movements: ${origin}/api/v1/intelligence?view=movements
- Sector totals: ${origin}/api/v1/intelligence?view=sectors
- Coverage and freshness: ${origin}/api/v1/coverage
- Verified off-board openings: ${origin}/api/v1/off-board-openings
- Off-board hiring signals: ${origin}/api/v1/signals

Call the capabilities URL first. It lists every supported filter. Unknown filters,
invalid values, and malformed cursors return HTTP 400 rather than silently returning
unfiltered data. Pass page.next_cursor unchanged with the same view and filters.
Company pages default to 10 records; movement pages default to 25.
Default job results use one shared deterministic company-diverse ranked
round-robin order across the preferred and compatibility APIs.
The after movement filter is exclusive; use the exact ISO-8601 boundary you want
excluded.

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
Funding movements are refreshed daily, remain standalone company movements,
and always include a navigable official-company or reputable-publication source URL.
The affected company's calibrated score is recomputed when newer funding is published.

## Compatibility and bulk endpoints
- Companies: ${origin}/api/v1/companies
- Jobs: ${origin}/api/v1/jobs
- Changes: ${origin}/api/v1/changes
- Coverage: ${origin}/api/v1/coverage
- Verified off-board openings: ${origin}/api/v1/off-board-openings
- Off-board hiring signals: ${origin}/api/v1/signals
- Company JSONL: ${origin}/exports/companies.jsonl
- Job JSONL: ${origin}/exports/jobs.jsonl
- Daily changes: ${origin}/exports/daily-changes.json

Job states are verified_open or verified_closed. Treat canonicalUrl as the
application source. Job provenance includes rawUrl, evidenceUrl, discoveryChannel,
parserVersion, snapshotRunId, firstSeenAt, lastSeenAt, sourceUpdatedAt, and
lastVerifiedAt. linkedInPresenceState is confirmed, not_observed, or unknown;
not_observed is not a claim that a role is absent from LinkedIn and must be
interpreted only with its evidence URL and check timestamp.
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
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
