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
      <section className="job-detail-hero">
        <div>
          <Link href={`/company/${job.company.slug}`} className="job-company-link">{job.company.name}</Link>
          <h1>{job.title}</h1><p>{job.summary}</p>
        </div>
        <aside className="job-status-panel">
          <span className={job.status === "verified_open" ? "verified-pill" : "closed-pill"}>{job.status.replaceAll("_", " ").toUpperCase()}</span>
          <strong>Last checked {new Date(job.lastVerifiedAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</strong>
          <span>{job.remoteStatus} / {job.employmentType}</span>
          <a href={job.canonicalUrl} target="_blank" rel="noreferrer" className="primary-cta">Open canonical posting</a>
        </aside>
      </section>
      <section className="fact-strip job-facts">
        <div><span>Company</span><strong>{job.company.name}</strong></div><div><span>Location</span><strong>{job.location}</strong></div><div><span>Role family</span><strong>{job.roleFamily}</strong></div><div><span>Compensation</span><strong>{job.compensation}</strong></div><div><span>Source</span><strong>{job.source}</strong></div>
      </section>
      <section className="truth-note"><span className="eyebrow">THE OH SHI RULE</span><h2>A listing is open only when its canonical source says so.</h2><p>OH SHI records the exact source and the last verification time. When the source closes a role, its state changes to verified_closed instead of silently disappearing.</p><Link href={`/api/v1/jobs/${job.id}`}>Inspect the machine-readable receipt</Link></section>
    </main>
  );
}
