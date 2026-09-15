import { ChangeFeedError, readChangeFeed } from "@/lib/change-feed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await readChangeFeed(new URL(request.url).searchParams);
    return Response.json({
      schema_version: "1.1",
      generated_at: new Date().toISOString(),
      order: "occurredAt ASC, id ASC",
      checkpoint_semantics: "exclusive tuple (occurredAt, id)",
      license: "CC BY 4.0 applies only to project-owned material; source rights remain with their owners.",
      ...result,
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=180" } });
  } catch (error) {
    if (error instanceof ChangeFeedError) {
      return Response.json({
        schema_version: "1.1",
        error: error.code,
        message: error.message,
        recovery: error.status === 410 ? "Run a fresh /api/v1/jobs query, then restart changes from its generated_at." : undefined,
      }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
