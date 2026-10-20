import type { EngineRecord, VerifiedFundingEvent } from "./types";

export type PublicDiscoveryEvidence = {
  firstSeenAt: string;
  indexedAt: string | null;
  lastCheckedAt: string;
  headquarters: { status: string; method: string | null; evidenceUrl: string | null; capture: { capturedAt: string; sha256: string } | null };
  fundingEvents: VerifiedFundingEvent[];
};
/** Existing production databases need no migration merely to read the listing. */
export async function discoveryEvidenceByCompany(db: D1Database): Promise<Map<string, PublicDiscoveryEvidence>> {
  let rows: Array<{ payload: string }>;
  try {
    rows = (await db.prepare("SELECT payload FROM daily_records").all<{ payload: string }>()).results;
  } catch (error) {
    if (/no such table: daily_records/i.test(String(error))) return new Map();
    throw error;
  }
  return new Map(rows.flatMap(row => {
    const record = JSON.parse(row.payload) as EngineRecord;
    const c = record.company;
    if (c.hqStatus !== "verified_us") return [];
    return [[c.id, {
      firstSeenAt: c.discoveredAt, indexedAt: c.indexedAt || null, lastCheckedAt: c.lastCheckedAt,
      headquarters: { status: c.hqStatus, method: c.hqMethod, evidenceUrl: c.hqEvidenceUrl, capture: c.hqCapture || null },
      fundingEvents: record.fundingEvents,
    }] as const];
  }));
}
