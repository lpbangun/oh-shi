import { env } from "cloudflare:workers";
import { ensureDatabase } from "./data";
import {
  GROWTH_WINDOW_DAYS,
  computeEvidenceConfidence,
  computeHiringScore,
} from "./hiring-score";
import {
  classifyRole,
  isUsEligible,
  summarizeCanonicalJob,
} from "./job-normalization";
import { TRACKED_BOARDS } from "./tracked-boards";
import { normalizeSector } from "./types";

type AshbyJob = {
  id: string;
  title: string;
  department?: string;
  employmentType?: string;
  location?: string;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  jobUrl: string;
  descriptionPlain?: string;
  address?: { postalAddress?: { addressCountry?: string } };
};

export { TRACKED_BOARDS, isBoardTracked } from "./tracked-boards";

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function refreshCanonicalBoards() {
  await ensureDatabase();
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id, external_id as externalId, company_id as companyId, status FROM jobs").all<{ id: string; externalId: string; companyId: string; status: string }>();
  const byExternalId = new Map(
    existing.results.map((job) => [`${job.companyId}:${job.externalId}`, job])
  );
  const observedByCompany = new Map<string, Set<string>>();
  let opened = 0;
  let closed = 0;
  let verified = 0;

  for (const source of TRACKED_BOARDS) {
    const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.board)}`, {
      headers: { "User-Agent": "OH-SHI/0.1 canonical-job-verifier" },
    });
    if (!response.ok) throw new Error(`Ashby board ${source.board} returned ${response.status}`);
    const payload = (await response.json()) as { jobs: AshbyJob[] };
    const visible = payload.jobs.filter((job) => job.isListed !== false && isUsEligible(job));
    const observed = new Set(visible.map((job) => job.id));
    observedByCompany.set(source.companyId, observed);

    const normalized = visible.map((job) => {
      const current = byExternalId.get(`${source.companyId}:${job.id}`);
      const id = current?.id || `job_${source.slug}_${job.id}`;
      const statusChanged = !current || current.status !== "verified_open";
      return {
        id,
        externalId: job.id,
        title: job.title,
        roleFamily: classifyRole(job.title, job.department),
        location: job.location || "Location not specified",
        remoteStatus: job.isRemote ? "Remote" : job.workplaceType || "See posting",
        employmentType: job.employmentType || "See posting",
        canonicalUrl: job.jobUrl,
        firstSeenAt: current ? now : job.publishedAt || now,
        summary: summarizeCanonicalJob(job),
        statusChanged,
      };
    });

    const statements: D1PreparedStatement[] = [];
    for (const group of chunks(normalized, 7)) {
      const values = group
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ashby', 'verified_open', ?, ?, NULL, ?)")
        .join(", ");
      const bindings = group.flatMap((job) => [
        job.id,
        source.companyId,
        job.externalId,
        job.title,
        job.roleFamily,
        job.location,
        job.remoteStatus,
        job.employmentType,
        "See posting",
        job.canonicalUrl,
        job.firstSeenAt,
        now,
        job.summary,
      ]);
      statements.push(env.DB.prepare(`INSERT INTO jobs (
          id, company_id, external_id, title, role_family, location, remote_status,
          employment_type, compensation, canonical_url, source, status, first_seen_at,
          last_verified_at, closed_at, summary
        ) VALUES ${values}
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, role_family=excluded.role_family, location=excluded.location,
        remote_status=excluded.remote_status, employment_type=excluded.employment_type,
        canonical_url=excluded.canonical_url, status='verified_open',
        last_verified_at=excluded.last_verified_at, closed_at=NULL, summary=excluded.summary`)
        .bind(...bindings));
    }

    const openedJobs = normalized.filter((job) => job.statusChanged);
    for (const group of chunks(openedJobs, 16)) {
      const values = group
        .map(() => "(?, 'job', ?, 'job_opened', ?, ?, ?, ?)")
        .join(", ");
      const bindings = group.flatMap((job) => [
        `change_open_${job.externalId}_${now.slice(0, 10)}`,
        job.id,
        `${job.title} opened`,
        "Canonical Ashby posting verified open.",
        now,
        job.canonicalUrl,
      ]);
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO changes (
          id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
        ) VALUES ${values}`).bind(...bindings));
    }
    if (statements.length) await env.DB.batch(statements);
    verified += normalized.length;
    opened += openedJobs.length;
  }

  for (const job of existing.results) {
    const observed = observedByCompany.get(job.companyId);
    if (!observed || observed.has(job.externalId) || job.status !== "verified_open") continue;
    await env.DB.prepare("UPDATE jobs SET status='verified_closed', closed_at=?, last_verified_at=? WHERE id=?")
      .bind(now, now, job.id).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
    ) SELECT ?, 'job', id, 'job_closed', title || ' closed', 'Canonical Ashby board no longer lists this role.', ?, canonical_url FROM jobs WHERE id=?`)
      .bind(`change_close_${job.externalId}_${now.slice(0, 10)}`, now, job.id).run();
    closed += 1;
  }

  const windowStart = new Date(Date.parse(now) - GROWTH_WINDOW_DAYS * 86_400_000).toISOString();
  const profiles = await env.DB.prepare(`SELECT
    id, industry, stage, founded_year as foundedYear, latest_funding_date as latestFundingDate,
    source_url as sourceUrl, careers_url as careersUrl, last_verified_at as lastVerifiedAt
    FROM companies`).all<{
      id: string;
      industry: string;
      stage: string;
      foundedYear: number | null;
      latestFundingDate: string | null;
      sourceUrl: string;
      careersUrl: string;
      lastVerifiedAt: string;
    }>();
  let scored = 0;

  for (const company of profiles.results) {
    const stats = await env.DB.prepare(`SELECT
      SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN status='verified_open' AND last_verified_at >= ? THEN 1 ELSE 0 END) AS freshOpen
      FROM jobs WHERE company_id = ?`)
      // Every observed open job was written with this exact refresh timestamp.
      // Using `now` deliberately excludes evidence from an older board pass.
      .bind(now, company.id)
      .first<{ openCount: number; freshOpen: number }>();
    const growth = await env.DB.prepare(`SELECT
      SUM(CASE WHEN changes.change_type='job_opened' THEN 1 ELSE 0 END) AS opened90,
      SUM(CASE WHEN changes.change_type='job_closed' THEN 1 ELSE 0 END) AS closed90
      FROM changes
      JOIN jobs ON jobs.id = changes.entity_id
      WHERE changes.entity_type='job'
        AND jobs.company_id = ?
        AND changes.occurred_at >= ?
        AND changes.occurred_at <= ?`)
      .bind(company.id, windowStart, now)
      .first<{ opened90: number; closed90: number }>();

    const boardVerified = observedByCompany.has(company.id);
    const lastVerifiedAt = boardVerified ? now : company.lastVerifiedAt;
    const openJobCount = Number(stats?.openCount || 0);

    const hiringScore = computeHiringScore({
      openJobCount,
      openedLast90: Number(growth?.opened90 || 0),
      closedLast90: Number(growth?.closed90 || 0),
      stage: company.stage,
      latestFundingDate: company.latestFundingDate,
      lastVerifiedAt,
      now,
    });
    const evidenceConfidence = computeEvidenceConfidence({
      openJobCount,
      freshlyVerifiedOpenCount: Number(stats?.freshOpen || 0),
      boardVerified,
      foundedYear: company.foundedYear,
      latestFundingDate: company.latestFundingDate,
      sourceUrl: company.sourceUrl,
      careersUrl: company.careersUrl,
      lastVerifiedAt,
      now,
    });

    await env.DB.prepare(
      "UPDATE companies SET sector=?, open_job_count=?, last_verified_at=?, hiring_score=?, evidence_confidence=? WHERE id=?"
    ).bind(
      normalizeSector(company.industry),
      openJobCount,
      lastVerifiedAt,
      hiringScore,
      evidenceConfidence,
      company.id
    ).run();
    scored += 1;
  }

  return {
    refreshed_at: now,
    boards: TRACKED_BOARDS.length,
    verified,
    opened,
    closed,
    scored,
  };
}
