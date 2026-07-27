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

Call the capabilities URL first. It lists every supported filter. Unknown filters,
invalid values, and malformed cursors return HTTP 400 rather than silently returning
unfiltered data. Pass page.next_cursor unchanged with the same view and filters.
Company pages default to 10 records; movement pages default to 25.
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

## Compatibility and bulk endpoints
- Companies: ${origin}/api/v1/companies
- Jobs: ${origin}/api/v1/jobs
- Changes: ${origin}/api/v1/changes
- Company JSONL: ${origin}/exports/companies.jsonl
- Job JSONL: ${origin}/exports/jobs.jsonl
- Daily changes: ${origin}/exports/daily-changes.json

Job states are verified_open or verified_closed. Treat canonicalUrl as the
application source. Hiring signal is a directional momentum score, not a probability.
Evidence confidence measures source completeness and verification freshness.
Software license: MIT. Project-owned factual exports: CC BY 4.0. Third-party source rights remain with their owners.
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
