import Link from "next/link";
import { notFound } from "next/navigation";
import { getJobById } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJobById(id);
  if (!job || !job.company) notFound();
  return (
    <main className="detail-page">
      <Link href="/" className="back-link">Back to all verified jobs</Link>
      <section className="job-detail-hero" aria-labelledby="job-title">
        <div>
          <Link href={`/company/${job.company.slug}`} className="job-company-link">{job.company.name}</Link>
          <div className="job-taxonomy" aria-label={`Category ${job.company.sector}; source industry ${job.company.industry}`}>
            <span>Category: {job.company.sector}</span>
            <span>Source industry: {job.company.industry}</span>
          </div>
          <h1 id="job-title">{job.title}</h1><p>{job.summary}</p>
        </div>
        <aside className="job-status-panel">
          <span className={job.status === "verified_open" ? "verified-pill" : "closed-pill"}>{job.status.replaceAll("_", " ").toUpperCase()}</span>
          <strong>Last checked {new Date(job.lastVerifiedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</strong>
          <span>{job.remoteStatus}</span>
          <span>{job.employmentType}</span>
          <a href={job.canonicalUrl} target="_blank" rel="noreferrer" className="primary-cta">Open canonical posting</a>
        </aside>
      </section>
      <section className="fact-strip job-facts">
        <div><span>Company</span><strong>{job.company.name}</strong></div><div><span>Category</span><strong>{job.company.sector}</strong></div><div><span>Source industry</span><strong>{job.company.industry}</strong></div><div><span>Location</span><strong>{job.location}</strong></div><div><span>Role family</span><strong>{job.roleFamily}</strong></div><div><span>Compensation</span><strong>{job.compensation}</strong></div><div><span>Source</span><strong>{job.source}</strong></div>
      </section>
      <section className="truth-note" aria-labelledby="truth-note-heading"><span className="eyebrow">THE OH SHI RULE</span><h2 id="truth-note-heading">A listing is open only when its canonical source says so.</h2><p>OH SHI records the exact source and the last verification time. When the source closes a role, its state changes to verified_closed instead of silently disappearing.</p><Link href={`/api/v1/jobs/${job.id}`}>Inspect the machine-readable receipt</Link></section>
    </main>
  );
}
