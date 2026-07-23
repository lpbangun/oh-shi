import Link from "next/link";
import { notFound } from "next/navigation";
import { getChangesForCompany, getCompanyBySlug, getJobsForCompany } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const company = await getCompanyBySlug(slug);
  if (!company) notFound();
  const [jobs, changes] = await Promise.all([getJobsForCompany(company.id), getChangesForCompany(company.id)]);

  return (
    <main className="detail-page">
      <Link href="/" className="back-link">Back to all companies</Link>
      <section className="company-hero">
        <div className="company-avatar company-avatar-xl">{company.name.slice(0, 2).toUpperCase()}</div>
        <div className="company-hero-copy">
          <span className="eyebrow">{company.industry}</span><h1>{company.name}</h1><p>{company.description}</p>
          <div className="detail-actions"><a href={company.careersUrl} target="_blank" rel="noreferrer" className="primary-cta">Canonical careers</a><Link href={`/api/v1/companies/${company.id}`} className="secondary-cta">JSON record</Link></div>
        </div>
        <div className="big-signal"><strong>{company.hiringScore}%</strong><span>90-day hiring probability</span><small>{company.evidenceConfidence}% evidence confidence</small></div>
      </section>
      <section className="fact-strip">
        <div><span>Stage</span><strong>{company.stage}</strong></div>
        <div><span>Founded</span><strong>{company.foundedYear || "Unknown"}</strong></div>
        <div><span>Team</span><strong>{company.employeeRange}</strong></div>
        <div><span>Headquarters</span><strong>{company.headquarters}</strong></div>
        <div><span>Latest funding</span><strong>{company.latestFundingLabel}</strong></div>
      </section>
      <div className="detail-grid">
        <section>
          <div className="section-heading compact"><h2>Verified jobs</h2><span>{jobs.length} tracked</span></div>
          <div className="detail-job-list">
            {jobs.map((job) => <Link href={`/job/${job.id}`} className="detail-job" key={job.id}><div><h3>{job.title}</h3><p>{job.location} / {job.roleFamily}</p></div><span className={job.status === "verified_open" ? "verified-pill" : "closed-pill"}>{job.status.replaceAll("_", " ").toUpperCase()}</span></Link>)}
            {jobs.length === 0 && <p className="empty-state">No U.S.-eligible jobs are currently verified open. This company remains on signal watch.</p>}
          </div>
        </section>
        <aside className="evidence-card">
          <span className="eyebrow">EVIDENCE RECEIPT</span><h2>Why this score?</h2><p>Funding, careers-page activity, company stage, and observed open roles are combined into a transparent directional signal.</p>
          <dl><div><dt>Status</dt><dd>{company.lifecycleStatus}</dd></div><div><dt>Funding mode</dt><dd>{company.fundingMode}</dd></div><div><dt>Source</dt><dd><a href={company.sourceUrl} target="_blank" rel="noreferrer">{company.domain}</a></dd></div></dl>
        </aside>
      </div>
      <section className="company-timeline"><div className="section-heading compact"><h2>Evidence trail</h2></div>{changes.map((change) => <article key={change.id}><time>{new Date(change.occurredAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</time><div><strong>{change.title}</strong><p>{change.description}</p></div><a href={change.sourceUrl} target="_blank" rel="noreferrer">Source</a></article>)}</section>
    </main>
  );
}
