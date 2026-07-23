export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const body = `# OH SHI - Startup Hiring Intelligence

OH SHI is a public source of startup hiring facts for humans and AI agents.

## Canonical machine-readable endpoints
- Companies: ${origin}/api/v1/companies
- Jobs: ${origin}/api/v1/jobs
- Changes: ${origin}/api/v1/changes
- Company JSONL: ${origin}/exports/companies.jsonl
- Job JSONL: ${origin}/exports/jobs.jsonl
- Daily changes: ${origin}/exports/daily-changes.json

Job states are verified_open or verified_closed. Treat canonical_url as the application source.
Software license: MIT. Project-owned factual exports: CC BY 4.0. Third-party source rights remain with their owners.
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
