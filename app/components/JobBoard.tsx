"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ChangeEvent, Company, Job } from "@/lib/types";

type Props = { companies: Company[]; jobs: Job[]; changes: ChangeEvent[] };

function formatDate(value: string | null) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function JobBoard({ companies, jobs, changes }: Props) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("All roles");
  const [location, setLocation] = useState("All locations");
  const roles = useMemo(() => ["All roles", ...Array.from(new Set(jobs.map((job) => job.roleFamily))).sort()], [jobs]);
  const filteredJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const haystack = `${job.title} ${job.company?.name || ""} ${job.location} ${job.roleFamily}`.toLowerCase();
      const queryMatch = !needle || haystack.includes(needle);
      const roleMatch = role === "All roles" || job.roleFamily === role;
      const locationMatch =
        location === "All locations" ||
        (location === "Remote" && job.remoteStatus === "Remote") ||
        (location === "New York" && job.location.toLowerCase().includes("new york")) ||
        (location === "San Francisco" && job.location.toLowerCase().includes("san francisco")) ||
        (location === "Washington, DC" && job.location.toLowerCase().includes("washington"));
      return queryMatch && roleMatch && locationMatch;
    });
  }, [jobs, location, query, role]);
  const highSignal = [...companies].sort((a, b) => b.hiringScore - a.hiringScore).slice(0, 3);

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">THE STARTUP HIRING SOURCE OF TRUTH</div>
          <h1>Oh, <em>shi-</em><br />they&apos;re hiring.</h1>
          <p>Verified startup jobs, fresh funding signals, and the companies most likely to hire next. Built for people. Structured for agents.</p>
        </div>
        <div className="hero-panel">
          <div className="pulse-line"><span className="live-dot" />DATA VERIFIED JUL 23, 2026</div>
          <div className="hero-stats">
            <div><strong>{jobs.length}</strong><span>verified open jobs</span></div>
            <div><strong>{companies.length}</strong><span>pilot companies</span></div>
            <div><strong>{changes.length}</strong><span>material changes</span></div>
          </div>
          <a href="#jobs" className="primary-cta">Search verified jobs</a>
        </div>
      </section>

      <section className="search-section" id="jobs">
        <div className="section-heading">
          <div><span className="section-number">01</span><h2>Open jobs</h2></div>
          <p>{filteredJobs.length} verified roles in this pilot view</p>
        </div>
        <div className="search-bar">
          <label className="search-input">
            <span aria-hidden="true">Q</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, company, role..." aria-label="Search jobs" />
          </label>
          <label>
            <span className="sr-only">Role family</span>
            <select value={role} onChange={(event) => setRole(event.target.value)}>{roles.map((item) => <option key={item}>{item}</option>)}</select>
          </label>
          <label>
            <span className="sr-only">Location</span>
            <select value={location} onChange={(event) => setLocation(event.target.value)}>
              {["All locations", "Remote", "New York", "San Francisco", "Washington, DC"].map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>

        <div className="job-layout">
          <div className="job-list">
            {filteredJobs.map((job) => (
              <article className="job-card" key={job.id}>
                <div className="company-avatar">{job.company?.name.slice(0, 2).toUpperCase()}</div>
                <div className="job-main">
                  <div className="job-title-line">
                    <div>
                      <Link href={`/job/${job.id}`}><h3>{job.title}</h3></Link>
                      <Link className="company-name" href={`/company/${job.company?.slug}`}>{job.company?.name}</Link>
                    </div>
                    <span className="verified-pill">VERIFIED OPEN</span>
                  </div>
                  <p>{job.summary}</p>
                  <div className="job-meta"><span>{job.location}</span><span>{job.roleFamily}</span><span>{job.employmentType}</span><span>{job.compensation}</span></div>
                </div>
                <a href={job.canonicalUrl} target="_blank" rel="noreferrer" className="apply-button">Open</a>
              </article>
            ))}
            {filteredJobs.length === 0 && <p className="empty-state">No jobs match those filters.</p>}
          </div>
          <aside className="signal-watch">
            <div className="aside-heading"><span>S</span><div><strong>Signal watch</strong><small>Highest hiring momentum</small></div></div>
            {highSignal.map((company) => (
              <Link href={`/company/${company.slug}`} className="signal-company" key={company.id}>
                <div><strong>{company.name}</strong><span>{company.latestFundingLabel}</span></div>
                <div className="score-ring" style={{ "--score": `${company.hiringScore * 3.6}deg` } as React.CSSProperties}><span>{company.hiringScore}</span></div>
              </Link>
            ))}
            <p className="score-disclaimer">A directional 0-100 momentum score, not a probability or a promise. The formula and its inputs are published in the README.</p>
          </aside>
        </div>
      </section>

      <section className="companies-section" id="companies">
        <div className="section-heading">
          <div><span className="section-number">02</span><h2>Company intelligence</h2></div>
          <Link href="/api/v1/companies">GET /api/v1/companies</Link>
        </div>
        <div className="company-grid">
          {companies.map((company) => (
            <Link href={`/company/${company.slug}`} className="company-card" key={company.id}>
              <div className="company-card-top"><span className="company-avatar company-avatar-large">{company.name.slice(0, 2).toUpperCase()}</span><span className="company-score">{company.hiringScore}</span></div>
              <h3>{company.name}</h3><p>{company.description}</p>
              <div className="company-facts"><span>{company.stage}</span><span>{company.employeeRange}</span><span>Founded {company.foundedYear || "?"}</span></div>
              <div className="company-card-footer"><span>{company.openJobCount} open jobs</span><span>View evidence</span></div>
            </Link>
          ))}
        </div>
      </section>

      <section className="changes-section" id="changes">
        <div className="section-heading">
          <div><span className="section-number">03</span><h2>What changed</h2></div>
          <Link href="/api/v1/changes">Incremental JSON feed</Link>
        </div>
        <div className="timeline">
          {changes.map((change) => (
            <article className="timeline-item" key={change.id}>
              <time>{formatDate(change.occurredAt)}</time><span className={`event-dot ${change.changeType}`} />
              <div><span className="event-type">{change.changeType.replaceAll("_", " ")}</span><h3>{change.title}</h3><p>{change.description}</p><a href={change.sourceUrl} target="_blank" rel="noreferrer">Source</a></div>
            </article>
          ))}
        </div>
      </section>

      <section className="agent-banner">
        <div><span className="eyebrow">BUILT TO BE CALLED</span><h2>Your agent can query OH SHI directly.</h2></div>
        <div className="endpoint-stack"><code>GET /api/v1/companies</code><code>GET /api/v1/jobs</code><code>GET /api/v1/changes</code><code>GET /exports/jobs.jsonl</code><Link href="/llms.txt">Read llms.txt</Link></div>
      </section>
    </main>
  );
}
