import Link from "next/link";
import { notFound } from "next/navigation";
import { getChangesForCompany, getCompanyBySlug, getJobsForCompany } from "@/lib/data";
import { companyScoreReceipts } from "@/lib/hiring-score";
import { isBoardTracked } from "@/lib/tracked-boards";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const company = await getCompanyBySlug(slug);
  if (!company) notFound();
  const [jobs, changes] = await Promise.all([getJobsForCompany(company.id), getChangesForCompany(company.id)]);
  const receipts = companyScoreReceipts(
    company,
    jobs,
    changes,
    new Date().toISOString(),
    isBoardTracked(company.id)
  );

  return (
    <main className="detail-page">
      <Link href="/" className="back-link">Back to all companies</Link>
      <section className="company-hero" aria-labelledby="company-name">
        <div className="company-avatar company-avatar-xl" aria-hidden="true">{company.name.slice(0, 2).toUpperCase()}</div>
        <div className="company-hero-copy">
          <div className="company-taxonomy" aria-label={`Category ${company.sector}; source industry ${company.industry}`}>
            <span className="eyebrow">Category · {company.sector}</span>
            <span className="industry-label">Source industry: {company.industry}</span>
          </div>
          <h1 id="company-name">{company.name}</h1><p>{company.description}</p>
          <div className="detail-actions"><a href={company.careersUrl} target="_blank" rel="noreferrer" className="primary-cta">Canonical careers</a><Link href={`/api/v1/companies/${company.id}`} className="secondary-cta">JSON record</Link></div>
        </div>
        <div className="big-signal"><strong>{receipts.hiring.value}</strong><span>Hiring momentum score (0-100)</span><small>Evidence confidence {receipts.evidence.value}/100</small></div>
      </section>
      <section className="fact-strip">
        <div><span>Category</span><strong>{company.sector}</strong></div>
        <div><span>Source industry</span><strong>{company.industry}</strong></div>
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
          <span className="eyebrow">EVIDENCE RECEIPT</span>
          <h2>Why these scores?</h2>
          <p>Every point is derived from the records below. Hiring signal measures momentum; confidence measures the evidence behind it.</p>
          <dl>
            {receipts.hiring.components.map((component) => (
              <div key={component.name}>
                <dt>{component.name}</dt>
                <dd>{component.points}/{component.max}</dd>
              </div>
            ))}
            <div><dt>Hiring signal total</dt><dd><b>{receipts.hiring.value}/100</b></dd></div>
          </dl>
          <dl style={{ marginTop: 18 }}>
            {receipts.evidence.components.map((component) => (
              <div key={component.name}>
                <dt>{component.name}</dt>
                <dd>{component.points}/{component.max}</dd>
              </div>
            ))}
            <div><dt>Confidence total</dt><dd><b>{receipts.evidence.value}/100</b></dd></div>
            <div><dt>Status</dt><dd>{company.lifecycleStatus}</dd></div>
            <div><dt>Funding mode</dt><dd>{company.fundingMode}</dd></div>
            <div><dt>Source</dt><dd><a href={company.sourceUrl} target="_blank" rel="noreferrer">{company.domain}</a></dd></div>
          </dl>
        </aside>
      </div>
      <section className="company-timeline" aria-labelledby="evidence-trail-heading">
        <div className="section-heading compact"><h2 id="evidence-trail-heading">Evidence trail</h2></div>
        {changes.length ? changes.map((change) => <article key={change.id}><time>{new Date(change.occurredAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</time><div><strong>{change.title}</strong><p>{change.description}</p></div><a href={change.sourceUrl} target="_blank" rel="noreferrer">Source</a></article>) : <p className="empty-state">No recorded changes for this company yet.</p>}
      </section>
    </main>
  );
}
