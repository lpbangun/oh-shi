import { JobSearchError } from "./job-search";
import type { Job } from "./types";

const CORE = ["id", "provider", "sourceId", "canonicalUrl", "title", "status", "summary"] as const;
const TOKENS = new Set<string>([...CORE, "description"]);

export type JobFields = { tokens: string; includeDescription: boolean };

/** Null means the default route must keep its original serializer untouched. */
export function parseJobFields(params: URLSearchParams): JobFields | null {
  if (!params.has("fields")) return null;
  const values = params.getAll("fields");
  if (values.length !== 1) throw new JobSearchError('Parameter "fields" may appear only once.');
  const tokens = values[0].split(",").map((token) => token.trim());
  if (tokens.some((token) => !TOKENS.has(token))) {
    throw new JobSearchError("fields must contain only id, provider, sourceId, canonicalUrl, title, status, summary, description (no blank tokens).");
  }
  const unique = new Set(tokens);
  return {
    // Requested-token identity, not serialized-row identity: core-only and
    // summary-only serialize alike but must not share an ETag validator.
    tokens: [...unique].sort().join(","),
    includeDescription: unique.has("description"),
  };
}

export function projectJob(job: Job, fields: JobFields) {
  return {
    id: job.id,
    provider: job.provider,
    sourceId: job.sourceId,
    canonicalUrl: job.canonicalUrl,
    title: job.title,
    status: job.status,
    summary: job.summary,
    ...(fields.includeDescription ? { description: job.description } : {}),
  };
}
