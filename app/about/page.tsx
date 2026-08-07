import type { Metadata } from "next";
import Link from "next/link";
import { getCoverageMetrics, listChanges, listCompanies, listJobs } from "@/lib/data";
import { DATA_AS_OF } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About — OH SHI",
  description:
    "How OH SHI verifies startup jobs, normalizes source industries into public sectors, and computes directional hiring momentum and evidence confidence scores.",
};

export default async function AboutPage() {
  const [companies, jobs, changes, coverage] = await Promise.all([
    listCompanies(),
    listJobs(true),
    listChanges(),
    getCoverageMetrics(),
  ]);
  const openJobs = jobs.filter((job) => job.status === "verified_open").length;
  const latestRefresh = coverage.lastCanonicalRefresh
    ? new Date(coverage.lastCanonicalRefresh).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
    : DATA_AS_OF.slice(0, 10);

  return (
    <main className="detail-page">
      <Link href="/" className="back-link">Back to open jobs</Link>

      <section className="truth-note" style={{ marginTop: 30 }}>
        <span className="eyebrow">What this is</span>
        <h2>Most job boards repost. We verify.</h2>
        <p>
          Every two hours we fetch each active company&apos;s own applicant tracking board or permitted
          first-party careers source, compare it with the previous canonical snapshot, and write down
          exactly what changed — roles opened, roles closed, nothing quietly deleted.
        </p>
      </section>

      <section style={{ marginTop: 50 }}>
        <div className="section-heading compact"><h2>How a row gets here</h2></div>
        <dl className="recipe">
          <div><dt>Run</dt><dd>Every two hours</dd></div>
          <div><dt>Method</dt><dd>Fetch the employer&apos;s canonical ATS board or permitted first-party structured careers page, never an aggregator</dd></div>
          <div><dt>Sources</dt><dd><b>Supported ATS boards</b> and permitted first-party structured careers pages</dd></div>
          <div><dt>On change</dt><dd>Write a diff to the change feed and keep the previous state</dd></div>
          <div><dt>On failed refresh</dt><dd>Keep the last verified state and record the source failure — never guess</dd></div>
          <div><dt>Publish</dt><dd>The same records to people and to agents, at the same time</dd></div>
        </dl>
      </section>

      <section style={{ marginTop: 50 }}>
        <div className="section-heading compact"><h2>How the two scores work</h2></div>
        <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: "62ch", color: "var(--ink2)" }}>
          Hiring signal is a directional 0–100 measure of observed hiring momentum, not a probability or
          calibrated forecast. It combines open-role volume (0–30), net role growth over 90 days (0–30),
          funding stage and recency (0–25), and canonical-board freshness (0–15). Evidence confidence is
          separate: it measures verification recency (0–40), canonical-board coverage (0–30), company-record
          completeness (0–20), and independent-source corroboration (0–10).
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: "62ch", color: "var(--ink2)", marginTop: 12 }}>
          The 30-day change shown beside each company counts roles opened minus roles closed in the change
          feed over the last 30 days. Where we hold no change events for a company in that window it reads
          flat, because that is what the evidence supports.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: "62ch", color: "var(--ink2)", marginTop: 12 }}>
          We retain each source&apos;s detailed industry label and normalize it into a stable public sector
          taxonomy for filters, sector totals, and movement views. Labels that do not match a published
          sector remain <b>Other</b>.
        </p>
      </section>

      <section className="fact-strip" style={{ marginTop: 40, borderTop: "1px solid var(--line)" }}>
        <div><span>Last canonical refresh</span><strong>{latestRefresh}</strong></div>
        <div><span>Cadence</span><strong>Every two hours</strong></div>
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
