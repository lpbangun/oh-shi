import { drizzle } from "drizzle-orm/d1";
import { companies } from "../../db/schema";
import type { AcquisitionCandidate, EngineRecord, HQEvidence, SourceReceipt, VerifiedFundingEvent } from "./types";

export type Assessment = {
  candidate: AcquisitionCandidate; domain: string | null;
  disposition: "accepted" | "pending_hq" | "non_us" | "unsupported" | "speculative" | "duplicate";
  reason: string | null; baselineKnown: boolean; hq: HQEvidence | null;
  funding: VerifiedFundingEvent | null;
};
export type SourceSnapshot = { receipt: SourceReceipt; assessments: Assessment[]; completedAt: string };

export async function initializeStore(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, domain TEXT NOT NULL,
      description TEXT NOT NULL, founded_year INTEGER, headquarters TEXT NOT NULL,
      employee_range TEXT NOT NULL, industry TEXT NOT NULL, sector TEXT NOT NULL,
      stage TEXT NOT NULL, funding_mode TEXT NOT NULL, lifecycle_status TEXT NOT NULL,
      hiring_score INTEGER NOT NULL, evidence_confidence INTEGER NOT NULL,
      latest_funding_label TEXT NOT NULL, latest_funding_date TEXT, careers_url TEXT NOT NULL,
      source_url TEXT NOT NULL, open_job_count INTEGER NOT NULL, last_verified_at TEXT NOT NULL
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS daily_records (domain TEXT PRIMARY KEY, payload TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS daily_events (id TEXT PRIMARY KEY, domain TEXT NOT NULL, payload TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS daily_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL)"),
  ]);
}
export async function readSource(db: D1Database, id: string): Promise<SourceSnapshot | null> {
  const row = await db.prepare("SELECT payload FROM daily_sources WHERE id=?").bind(id).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) : null;
}
export async function readRecords(db: D1Database): Promise<EngineRecord[]> {
  return (await db.prepare("SELECT payload FROM daily_records ORDER BY domain").all<{ payload: string }>()).results.map(r => JSON.parse(r.payload));
}
/** Local public-consumer data layer: intentionally no job JOIN or positive-job filter. */
export async function listDailyCompanies(db: D1Database) {
  const rows = await drizzle(db).select().from(companies).all();
  const records = new Map((await readRecords(db)).map(r => [r.company.id, r]));
  return rows.map(company => ({ ...company, fundingEvents: records.get(company.id)?.fundingEvents || [] }));
}
export async function commitSource(db: D1Database, id: string, snapshot: SourceSnapshot, records: EngineRecord[]) {
  const beforeCompanies = Number((await db.prepare("SELECT COUNT(*) AS n FROM companies").first<{ n: number }>())?.n);
  const beforeEvents = Number((await db.prepare("SELECT COUNT(*) AS n FROM daily_events").first<{ n: number }>())?.n);
  const statements: D1PreparedStatement[] = [];
  for (const record of records) {
    const c = record.company;
    statements.push(db.prepare("INSERT INTO daily_records VALUES (?,?) ON CONFLICT(domain) DO UPDATE SET payload=excluded.payload").bind(c.domain, JSON.stringify(record)));
    if (c.hqStatus === "verified_us") {
      statements.push(db.prepare(`INSERT INTO companies (
        id,slug,name,domain,description,founded_year,headquarters,employee_range,industry,sector,
        stage,funding_mode,lifecycle_status,hiring_score,evidence_confidence,latest_funding_label,
        latest_funding_date,careers_url,source_url,open_job_count,last_verified_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET latest_funding_label=excluded.latest_funding_label,
      latest_funding_date=excluded.latest_funding_date,last_verified_at=excluded.last_verified_at`).bind(
        c.id,c.slug,c.name,c.domain,c.description,c.foundedYear,c.headquarters,c.employeeRange,c.industry,"Not published",
        c.stage,c.fundingMode,c.lifecycleStatus,0,0,c.latestFundingLabel,c.latestFundingDate,c.careersUrl,c.sourceUrl,c.openJobCount,c.lastCheckedAt
      ));
    }
    for (const event of record.fundingEvents) statements.push(db.prepare("INSERT INTO daily_events VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind(event.id,c.domain,JSON.stringify(event)));
  }
  // D1 batch is transactional: the checkpoint can never get ahead of its rows.
  statements.push(db.prepare("INSERT INTO daily_sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind(id,JSON.stringify(snapshot)));
  await db.batch(statements);
  return {
    companies: Number((await db.prepare("SELECT COUNT(*) AS n FROM companies").first<{ n: number }>())?.n) - beforeCompanies,
    events: Number((await db.prepare("SELECT COUNT(*) AS n FROM daily_events").first<{ n: number }>())?.n) - beforeEvents,
  };
}
