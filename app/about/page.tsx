import type { Metadata } from "next";
import Link from "next/link";
import { listChanges, listCompanies, listJobs } from "@/lib/data";
import { DATA_AS_OF } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About — OH SHI",
  description:
    "How OH SHI verifies startup jobs and computes its directional hiring-momentum and evidence-confidence scores.",
};

export default async function AboutPage() {
  const [companies, jobs, changes] = await Promise.all([listCompanies(), listJobs(true), listChanges()]);
  const openJobs = jobs.filter((job) => job.status === "verified_open").length;

  return (
    <main className="detail-page">
      <Link href="/" className="back-link">Back to open jobs</Link>

      <section className="truth-note" style={{ marginTop: 30 }}>
        <span className="eyebrow">What this is</span>
        <h2>Most job boards repost. We verify.</h2>
        <p>
          Every day we fetch each company&apos;s own applicant tracking board, compare it to yesterday, and
          write down exactly what changed — roles opened, roles closed, nothing quietly deleted.
        </p>
      </section>

      <section style={{ marginTop: 50 }}>
        <div className="section-heading compact"><h2>How a row gets here</h2></div>
        <dl className="recipe">
          <div><dt>Run</dt><dd>Every day at <b>07:30 UTC</b></dd></div>
          <div><dt>Method</dt><dd>Fetch the employer&apos;s own applicant tracking board, never an aggregator</dd></div>
          <div><dt>Sources</dt><dd><b>Ashby</b> and company careers pages</dd></div>
          <div><dt>On change</dt><dd>Write a diff to the change feed and keep the previous state</dd></div>
          <div><dt>On stale</dt><dd>Mark the record <b>unverified</b> — never guess</dd></div>
          <div><dt>Publish</dt><dd>The same records to people and to agents, at the same time</dd></div>
        </dl>
      </section>

      <section style={{ marginTop: 50 }}>
        <div className="section-heading compact"><h2>How the two scores work</h2></div>
        <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: "62ch", color: "var(--ink2)" }}>
          Hiring signal is a directional 0–100 measure of observed hiring momentum, not a probability or
          calibrated forecast. It combines open-role volume, net openings over 90 days, funding stage and
          recency, and canonical-board freshness. Evidence confidence is separate: it measures verification
          recency, coverage, company-record completeness, and independent-source corroboration.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: "62ch", color: "var(--ink2)", marginTop: 12 }}>
          The 30-day change shown beside each company counts roles opened minus roles closed in the change
          feed over the last 30 days. Where we hold no change events for a company in that window it reads
          flat, because that is what the evidence supports.
        </p>
      </section>

      <section className="fact-strip" style={{ marginTop: 40, borderTop: "1px solid var(--line)" }}>
        <div><span>Data as of</span><strong>{DATA_AS_OF.slice(0, 10)}</strong></div>
        <div><span>Cadence</span><strong>Daily, 07:30 UTC</strong></div>
        <div><span>Companies</span><strong>{companies.length}</strong></div>
        <div><span>Open roles</span><strong>{openJobs}</strong></div>
        <div><span>Recorded changes</span><strong>{changes.length}</strong></div>
      </section>

      <section className="truth-note" style={{ marginTop: 50 }}>
        <span className="eyebrow">Naming</span>
        <h2>OH SHI is the Operational Headquarters for Startup Hiring Intelligence.</h2>
        <p>
          It is also what you say when you find out the company you have been watching just opened the role
          you wanted. Both readings are intended.
        </p>
        <Link href="/llms.txt">Read llms.txt →</Link>
      </section>
    </main>
  );
}
