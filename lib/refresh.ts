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

const boards = [
  { companyId: "company_ataraxis", slug: "ataraxis-ai", board: "ataraxis-ai" },
  { companyId: "company_cognition", slug: "cognition", board: "cognition" },
  { companyId: "company_conduct", slug: "conduct", board: "conduct" },
  { companyId: "company_edison", slug: "edison-scientific", board: "Edison Scientific" },
  { companyId: "company_hotplate", slug: "hotplate", board: "hotplate" },
];

export async function refreshCanonicalBoards() {
  await ensureDatabase();
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id, external_id as externalId, company_id as companyId, status FROM jobs").all<{ id: string; externalId: string; companyId: string; status: string }>();
  const byExternalId = new Map(existing.results.map((job) => [job.externalId, job]));
  const observedByCompany = new Map<string, Set<string>>();
  let opened = 0;
  let closed = 0;
  let verified = 0;

  for (const source of boards) {
    const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.board)}`, {
      headers: { "User-Agent": "OH-SHI/0.1 canonical-job-verifier" },
    });
    if (!response.ok) throw new Error(`Ashby board ${source.board} returned ${response.status}`);
    const payload = (await response.json()) as { jobs: AshbyJob[] };
    const visible = payload.jobs.filter((job) => job.isListed !== false && isUsEligible(job));
    const observed = new Set(visible.map((job) => job.id));
    observedByCompany.set(source.companyId, observed);

    for (const job of visible) {
      const current = byExternalId.get(job.id);
      const id = current?.id || `job_${source.slug}_${job.id}`;
      const statusChanged = !current || current.status !== "verified_open";
      await env.DB.prepare(`INSERT INTO jobs (
        id, company_id, external_id, title, role_family, location, remote_status,
        employment_type, compensation, canonical_url, source, status, first_seen_at,
        last_verified_at, closed_at, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ashby', 'verified_open', ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, role_family=excluded.role_family, location=excluded.location,
        remote_status=excluded.remote_status, employment_type=excluded.employment_type,
        canonical_url=excluded.canonical_url, status='verified_open',
        last_verified_at=excluded.last_verified_at, closed_at=NULL, summary=excluded.summary`)
        .bind(
          id,
          source.companyId,
          job.id,
          job.title,
          classifyRole(job.title, job.department),
          job.location || "Location not specified",
          job.isRemote ? "Remote" : job.workplaceType || "See posting",
          job.employmentType || "See posting",
          "See posting",
          job.jobUrl,
          current ? now : job.publishedAt || now,
          now,
          summarizeCanonicalJob(job)
        ).run();
      verified += 1;
      if (statusChanged) {
        opened += 1;
        await env.DB.prepare(`INSERT OR IGNORE INTO changes (
          id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
        ) VALUES (?, 'job', ?, 'job_opened', ?, ?, ?, ?)`)
          .bind(`change_open_${job.id}_${now.slice(0, 10)}`, id, `${job.title} opened`, "Canonical Ashby posting verified open.", now, job.jobUrl)
          .run();
      }
    }
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
    id, stage, founded_year as foundedYear, latest_funding_date as latestFundingDate,
    source_url as sourceUrl, careers_url as careersUrl, last_verified_at as lastVerifiedAt
    FROM companies`).all<{
      id: string;
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
      SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS opened90,
      SUM(CASE WHEN closed_at IS NOT NULL AND closed_at >= ? THEN 1 ELSE 0 END) AS closed90,
      SUM(CASE WHEN status='verified_open' AND last_verified_at >= ? THEN 1 ELSE 0 END) AS freshOpen
      FROM jobs WHERE company_id = ?`)
      .bind(windowStart, windowStart, now, company.id)
      .first<{ openCount: number; opened90: number; closed90: number; freshOpen: number }>();

    const boardVerified = observedByCompany.has(company.id);
    const lastVerifiedAt = boardVerified ? now : company.lastVerifiedAt;
    const openJobCount = Number(stats?.openCount || 0);

    const hiringScore = computeHiringScore({
      openJobCount,
      openedLast90: Number(stats?.opened90 || 0),
      closedLast90: Number(stats?.closed90 || 0),
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
      "UPDATE companies SET open_job_count=?, last_verified_at=?, hiring_score=?, evidence_confidence=? WHERE id=?"
    ).bind(openJobCount, lastVerifiedAt, hiringScore, evidenceConfidence, company.id).run();
    scored += 1;
  }

  return { refreshed_at: now, boards: boards.length, verified, opened, closed, scored };
}
