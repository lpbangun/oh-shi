"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { Company, DashboardJob } from "@/lib/types";
import { CompanyLogo } from "./CompanyLogo";

const isoDate = (value: string | null) => (value ? value.slice(0, 10) : "unknown");

function useModalChrome(onClose: () => void) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return closeRef;
}

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal">{children}</div>
    </div>
  );
}

export function JobModal({
  job,
  company,
  backTo,
  onBack,
  onOpenCompany,
  onClose,
}: {
  job: DashboardJob;
  company?: Company;
  backTo?: string;
  onBack: () => void;
  onOpenCompany: () => void;
  onClose: () => void;
}) {
  const closeRef = useModalChrome(onClose);
  const open = job.status === "verified_open";

  return (
    <Overlay onClose={onClose}>
      <div className="modal-head">
        <div>
          {backTo ? (
            <button className="modal-back" type="button" onClick={onBack}>← Back to {backTo}</button>
          ) : null}
          <h3 id="modal-title">{job.title}</h3>
          <p className="sub">{company?.name} · {job.location} · {job.employmentType}</p>
        </div>
        <button ref={closeRef} className="modal-close" type="button" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        <p>{job.summary}</p>
        <dl className="modal-facts">
          <div><dt>Status</dt><dd>{open ? "Verified open" : "Verified closed"}</dd></div>
          <div><dt>Department</dt><dd>{job.roleFamily}</dd></div>
          <div><dt>Arrangement</dt><dd>{job.remoteStatus}</dd></div>
          <div><dt>Compensation</dt><dd>{job.compensation}</dd></div>
          <div><dt>Hiring signal</dt><dd>{company ? company.hiringScore : "—"}</dd></div>
        </dl>
        <div className="receipt">
          last_verified_at <b>{isoDate(job.lastVerifiedAt)}</b><br />
          first_seen_at <b>{isoDate(job.firstSeenAt)}</b><br />
          {job.closedAt ? <>closed_at <b>{isoDate(job.closedAt)}</b><br /></> : null}
          source <b>{job.source}</b>{company ? <> · evidence_confidence <b>{company.evidenceConfidence}</b></> : null}<br />
          canonical_url <b>{job.canonicalUrl}</b>
        </div>
      </div>
      <div className="modal-foot">
        <a className="primary-cta" href={job.canonicalUrl} target="_blank" rel="noreferrer">Open canonical posting ↗</a>
        <button className="secondary-cta" type="button" onClick={onOpenCompany}>All roles at {company?.name}</button>
        <Link className="secondary-cta" href={`/job/${job.id}`}>Full record →</Link>
      </div>
    </Overlay>
  );
}

export function CompanyModal({
  company,
  roles,
  delta,
  onOpenJob,
  onFilterToCompany,
  onClose,
}: {
  company: Company;
  roles: DashboardJob[];
  delta: number;
  onOpenJob: (jobId: string) => void;
  onFilterToCompany: () => void;
  onClose: () => void;
}) {
  const closeRef = useModalChrome(onClose);
  const openCount = roles.filter((role) => role.status === "verified_open").length;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";

  return (
    <Overlay onClose={onClose}>
      <div className="modal-head">
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <CompanyLogo domain={company.domain} name={company.name} />
          <div>
            <h3 id="modal-title">{company.name}</h3>
            <p className="sub">{company.industry} · {company.headquarters}</p>
          </div>
        </div>
        <button ref={closeRef} className="modal-close" type="button" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        <p>{company.description}</p>
        <dl className="modal-facts">
          <div><dt>Stage</dt><dd>{company.stage}</dd></div>
          <div><dt>Latest funding</dt><dd>{company.latestFundingLabel}</dd></div>
          <div><dt>Headcount</dt><dd>{company.employeeRange}</dd></div>
          <div><dt>Hiring signal</dt><dd>{company.hiringScore} <span className="dim">conf {company.evidenceConfidence}</span></dd></div>
          <div>
            <dt>Open roles</dt>
            <dd>{openCount} <span className={`delta ${direction}`} style={{ fontSize: 11 }}>{arrow} {delta > 0 ? "+" : ""}{delta} / 30d</span></dd>
          </div>
        </dl>

        <div className="modal-subhead">{roles.length} posting{roles.length === 1 ? "" : "s"} on record</div>
        {roles.length > 0 ? (
          roles.map((role) => {
            const roleOpen = role.status === "verified_open";
            return (
              <button
                key={role.id}
                type="button"
                className={`role-row${roleOpen ? "" : " closed"}`}
                onClick={() => onOpenJob(role.id)}
              >
                <span className="state" aria-hidden="true">{roleOpen ? "■" : "□"}</span>
                <span className="title">{role.title}</span>
                <span className="loc">{role.location}</span>
                <span className="comp">{role.compensation}</span>
              </button>
            );
          })
        ) : (
          <p className="dim" style={{ padding: "16px 0" }}>
            No postings on record. A high signal with zero open roles usually means a recent raise and nothing posted yet.
          </p>
        )}

        <div className="receipt" style={{ marginTop: 20 }}>
          last_verified_at <b>{isoDate(company.lastVerifiedAt)}</b><br />
          evidence_confidence <b>{company.evidenceConfidence}</b><br />
          source <b>{company.sourceUrl}</b>
        </div>
      </div>
      <div className="modal-foot">
        <Link className="primary-cta" href={`/company/${company.slug}`}>Company page →</Link>
        <button className="secondary-cta" type="button" onClick={onFilterToCompany}>Filter jobs to {company.name}</button>
      </div>
    </Overlay>
  );
}
