import { env } from "cloudflare:workers";
import { ensureDatabase } from "./data";

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

function isUsEligible(job: AshbyJob) {
  const country = job.address?.postalAddress?.addressCountry || "";
  const location = job.location || "";
  return country === "United States" || job.isRemote === true || /remote|united states|u\.s\.|new york|san francisco|washington|boston|seattle|austin|los angeles/i.test(location);
}

function roleFamily(title: string, department = "") {
  const text = `${title} ${department}`.toLowerCase();
  if (/people|talent|recruit|human resources|\bhr\b|workplace/.test(text)) return "People operations";
  if (/sales|growth|gtm|marketing|capture|revenue/.test(text)) return "GTM";
  if (/operations|chief of staff|strategy/.test(text)) return "Operations";
  if (/research|scient|eval|data|biostat/.test(text)) return "Data and research";
  if (/engineer|developer|technical|software/.test(text)) return "Engineering";
  if (/product|design/.test(text)) return "Product";
  return "Other";
}

function summary(job: AshbyJob) {
  const plain = (job.descriptionPlain || "").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 220) : `Canonical posting for ${job.title}.`;
}

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
          roleFamily(job.title, job.department),
          job.location || "Location not specified",
          job.isRemote ? "Remote" : job.workplaceType || "See posting",
          job.employmentType || "See posting",
          "See posting",
          job.jobUrl,
          current ? now : job.publishedAt || now,
          now,
          summary(job)
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

  for (const source of boards) {
    const count = await env.DB.prepare("SELECT COUNT(*) as count FROM jobs WHERE company_id=? AND status='verified_open'").bind(source.companyId).first<{ count: number }>();
    await env.DB.prepare("UPDATE companies SET open_job_count=?, last_verified_at=? WHERE id=?").bind(Number(count?.count || 0), now, source.companyId).run();
  }

  return { refreshed_at: now, boards: boards.length, verified, opened, closed };
}
