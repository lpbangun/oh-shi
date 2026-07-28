"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketMovement, SectorStat } from "@/lib/derive";
import type { ChangeEvent, Company, Job } from "@/lib/types";
import { ColumnMenu, type MenuGroup } from "./ColumnMenu";
import { CompanyLogo } from "./CompanyLogo";
import { CompanyModal, JobModal } from "./RecordModal";
import { Ticker } from "./Ticker";

type Props = {
  companies: Company[];
  jobs: Job[];
  changes: ChangeEvent[];
  sectors: SectorStat[];
  movements: MarketMovement[];
  deltas: Record<string, number>;
  facets: { departments: string[]; locations: string[]; employmentTypes: string[] };
  dataAsOf: string;
};

type SortId =
  | "signal" | "title" | "title_desc" | "company" | "company_desc"
  | "sector" | "dept" | "loc" | "comp_low" | "comp_high" | "recent" | "oldest";

const SORT_LABELS: Record<SortId, string> = {
  signal: "hiring signal",
  title: "role A–Z",
  title_desc: "role Z–A",
  company: "company A–Z",
  company_desc: "company Z–A",
  sector: "sector A–Z",
  dept: "department A–Z",
  loc: "location A–Z",
  comp_low: "compensation, low to high",
  comp_high: "compensation, high to low",
  recent: "most recently verified",
  oldest: "oldest verified first",
};

const DESCENDING = new Set<SortId>(["signal", "title_desc", "company_desc", "comp_high", "recent"]);

/** Lowest quoted figure in a compensation string; unquoted ranges sort last. */
function compensationFloor(value: string) {
  const match = value.match(/\$\s?([\d.]+)\s?([km])?/i);
  if (!match) return -1;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return -1;
  const unit = (match[2] || "").toLowerCase();
  return unit === "m" ? amount * 1_000_000 : unit === "k" ? amount * 1_000 : amount;
}

const directionOf = (value: number) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
const arrowOf = (value: number) => (value > 0 ? "▲" : value < 0 ? "▼" : "—");
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

type TableKey = "name" | "sector" | "stage" | "funding" | "size" | "open" | "delta" | "confidence" | "score";
const TABLE_LABELS: Record<TableKey, string> = {
  name: "company name", sector: "sector", stage: "stage", funding: "latest funding",
  size: "headcount", open: "open roles", delta: "30-day change", confidence: "confidence", score: "hiring signal",
};
/** Phone-only presets, because the sortable table headers are hidden there. */
const PHONE_SORTS: { id: string; label: string; key: TableKey; dir: 1 | -1 }[] = [
  { id: "score-desc", label: "Hiring signal, high → low", key: "score", dir: -1 },
  { id: "open-desc", label: "Open roles, most first", key: "open", dir: -1 },
  { id: "delta-desc", label: "30-day change, biggest gain", key: "delta", dir: -1 },
  { id: "delta-asc", label: "30-day change, biggest drop", key: "delta", dir: 1 },
  { id: "name-asc", label: "Company A → Z", key: "name", dir: 1 },
  { id: "confidence-desc", label: "Confidence, high → low", key: "confidence", dir: -1 },
];

const COMPANY_PAGE_SIZE = 10;
const CHANGE_PAGE_SIZE = 25;
const MARKET_MOVEMENT_PAGE_SIZE = 5;

function InfoExplainer({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details
      className="info-explainer"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary role="button" aria-label={`${label} explainer`}>i</summary>
      <div className="info-popover">
        <b>{label}</b>
        {children}
      </div>
    </details>
  );
}

export function JobBoard({ companies, jobs, changes, sectors, movements, deltas, facets, dataAsOf }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sector, setSector] = useState("");
  const [dept, setDept] = useState("");
  const [loc, setLoc] = useState("");
  const [sort, setSort] = useState<SortId>("signal");
  const [page, setPage] = useState(0);

  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [tableSort, setTableSort] = useState<{ key: TableKey; dir: 1 | -1 }>({ key: "score", dir: -1 });
  const [tablePage, setTablePage] = useState(0);
  const [movementPage, setMovementPage] = useState(0);
  const [changePage, setChangePage] = useState(0);

  const [modal, setModal] = useState<{ kind: "job" | "company"; id: string; backTo?: string } | null>(null);
  const [tab, setTab] = useState<"humans" | "agents">("humans");

  // Phones get shorter pages; 20 rows is about one thumb-scroll.
  const [perPage, setPerPage] = useState(50);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const apply = () => {
      setPerPage(media.matches ? 20 : 50);
      setPage(0);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const jobsSection = useRef<HTMLElement>(null);
  const movementsSection = useRef<HTMLDivElement>(null);
  const sectorSection = useRef<HTMLDivElement>(null);
  const companiesSection = useRef<HTMLDivElement>(null);
  const changesSection = useRef<HTMLDivElement>(null);

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const companyBySlug = useMemo(() => new Map(companies.map((c) => [c.slug, c])), [companies]);
  const sectorOf = useCallback(
    (job: Job) => companyById.get(job.companyId)?.sector || "Other",
    [companyById]
  );
  const scoreOf = useCallback(
    (job: Job) => companyById.get(job.companyId)?.hiringScore || 0,
    [companyById]
  );

  const visibleJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = jobs.filter((job) => {
      const company = companyById.get(job.companyId);
      if (needle) {
        const haystack = `${job.title} ${company?.name || ""} ${job.roleFamily} ${job.location} ${job.employmentType} ${company?.sector || ""} ${company?.industry || ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (status === "open" && job.status !== "verified_open") return false;
      if (status === "closed" && job.status === "verified_open") return false;
      if (sector && sectorOf(job) !== sector) return false;
      if (dept && job.roleFamily !== dept) return false;
      if (loc && job.location !== loc) return false;
      return true;
    });

    const byTitle = (a: Job, b: Job) => a.title.localeCompare(b.title);
    const nameOf = (job: Job) => companyById.get(job.companyId)?.name || "";
    const comparators: Record<SortId, (a: Job, b: Job) => number> = {
      signal: (a, b) => scoreOf(b) - scoreOf(a) || byTitle(a, b),
      title: byTitle,
      title_desc: (a, b) => b.title.localeCompare(a.title),
      company: (a, b) => nameOf(a).localeCompare(nameOf(b)) || byTitle(a, b),
      company_desc: (a, b) => nameOf(b).localeCompare(nameOf(a)) || byTitle(a, b),
      sector: (a, b) => sectorOf(a).localeCompare(sectorOf(b)) || byTitle(a, b),
      dept: (a, b) => a.roleFamily.localeCompare(b.roleFamily) || byTitle(a, b),
      loc: (a, b) => a.location.localeCompare(b.location) || byTitle(a, b),
      comp_low: (a, b) => compensationFloor(a.compensation) - compensationFloor(b.compensation),
      comp_high: (a, b) => compensationFloor(b.compensation) - compensationFloor(a.compensation),
      recent: (a, b) => b.lastVerifiedAt.localeCompare(a.lastVerifiedAt) || scoreOf(b) - scoreOf(a),
      oldest: (a, b) => a.lastVerifiedAt.localeCompare(b.lastVerifiedAt) || scoreOf(b) - scoreOf(a),
    };
    return rows.sort(comparators[sort]);
  }, [companyById, dept, jobs, loc, query, scoreOf, sector, sectorOf, sort, status]);

  const pageCount = Math.max(1, Math.ceil(visibleJobs.length / perPage));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * perPage;
  const pageRows = visibleJobs.slice(pageStart, pageStart + perPage);
  const pageEnd = Math.min(pageStart + perPage, visibleJobs.length);
  const uniqueCompanies = new Set(pageRows.map((job) => job.companyId)).size;
  const filtersActive = Boolean(query || status || sector || dept || loc) || sort !== "signal";

  const clearFilters = useCallback(() => {
    setQuery(""); setStatus(""); setSector(""); setDept(""); setLoc(""); setSort("signal"); setPage(0);
  }, []);

  function applyMenu(optionId: string) {
    const separator = optionId.indexOf(":");
    const scope = optionId.slice(0, separator);
    const value = optionId.slice(separator + 1);
    if (scope === "sort") setSort(value as SortId);
    if (scope === "status") setStatus(value);
    if (scope === "sector") setSector(value);
    if (scope === "dept") setDept(value);
    if (scope === "loc") setLoc(value);
    setPage(0);
  }

  const sortGroup = (options: [SortId, string][]): MenuGroup => ({
    heading: "Sort",
    options: options.map(([id, label]) => ({ id: `sort:${id}`, label, selected: sort === id })),
  });
  const filterGroup = (heading: string, scope: string, current: string, values: string[], allLabel: string): MenuGroup => ({
    heading,
    options: [{ id: `${scope}:`, label: allLabel, selected: current === "" }].concat(
      values.map((value) => ({ id: `${scope}:${value}`, label: value, selected: current === value }))
    ),
  });
  const arrowFor = (ids: SortId[]) => (ids.includes(sort) ? (DESCENDING.has(sort) ? "↓" : "↑") : null);

  /* ── companies table ─────────────────────────────── */
  const sortedCompanies = useMemo(() => {
    const pick = (company: Company): string | number => {
      switch (tableSort.key) {
        case "name": return company.name;
        case "sector": return company.sector;
        case "stage": return company.stage;
        case "funding": return company.latestFundingLabel;
        case "size": return Number.parseInt(company.employeeRange, 10) || 0;
        case "open": return company.openJobCount;
        case "delta": return deltas[company.id] || 0;
        case "confidence": return company.evidenceConfidence;
        default: return company.hiringScore;
      }
    };
    return [...companies].sort((a, b) => {
      const left = pick(a);
      const right = pick(b);
      const base = typeof left === "string" ? left.localeCompare(right as string) : left - (right as number);
      return (tableSort.dir === -1 ? -base : base) || b.hiringScore - a.hiringScore;
    });
  }, [companies, deltas, tableSort]);

  const tablePages = Math.max(1, Math.ceil(sortedCompanies.length / COMPANY_PAGE_SIZE));
  const safeTablePage = Math.min(tablePage, tablePages - 1);
  const tableStart = safeTablePage * COMPANY_PAGE_SIZE;
  const tableRows = sortedCompanies.slice(tableStart, tableStart + COMPANY_PAGE_SIZE);
  const tableEnd = Math.min(tableStart + COMPANY_PAGE_SIZE, sortedCompanies.length);

  const movementPages = Math.max(1, Math.ceil(movements.length / MARKET_MOVEMENT_PAGE_SIZE));
  const safeMovementPage = Math.min(movementPage, movementPages - 1);
  const movementStart = safeMovementPage * MARKET_MOVEMENT_PAGE_SIZE;
  const movementRows = movements.slice(movementStart, movementStart + MARKET_MOVEMENT_PAGE_SIZE);
  const movementEnd = Math.min(movementStart + MARKET_MOVEMENT_PAGE_SIZE, movements.length);

  const changePages = Math.max(1, Math.ceil(changes.length / CHANGE_PAGE_SIZE));
  const safeChangePage = Math.min(changePage, changePages - 1);
  const changeStart = safeChangePage * CHANGE_PAGE_SIZE;
  const changeRows = changes.slice(changeStart, changeStart + CHANGE_PAGE_SIZE);
  const changeEnd = Math.min(changeStart + CHANGE_PAGE_SIZE, changes.length);
  const companyForChange = (change: ChangeEvent) => {
    const companyId = change.entityType === "company"
      ? change.entityId
      : jobs.find((job) => job.id === change.entityId)?.companyId;
    return companyId ? companyById.get(companyId) : undefined;
  };

  function sortTable(key: TableKey) {
    const textual = key === "name" || key === "sector" || key === "stage" || key === "funding";
    setTableSort((current) =>
      current.key === key ? { key, dir: current.dir === -1 ? 1 : -1 } : { key, dir: textual ? 1 : -1 }
    );
    setTablePage(0);
  }

  const tableHeader = (key: TableKey, label: string, right = false) => (
    <th className={right ? "right" : undefined} key={key}>
      <button type="button" className={tableSort.key === key ? "on" : undefined} onClick={() => sortTable(key)}>
        {label}<span className="arrow">{tableSort.dir === -1 ? "↓" : "↑"}</span>
      </button>
      {key === "confidence" ? (
        <InfoExplainer label="Confidence">
          <p>Verification recency (40), coverage of verified open roles (30), profile completeness (20), and independent source corroboration (10).</p>
        </InfoExplainer>
      ) : null}
      {key === "score" ? (
        <InfoExplainer label="Hiring signal">
          <p>Open-role volume (30), 90-day net growth (30), funding stage and recency (25), and board freshness (15).</p>
        </InfoExplainer>
      ) : null}
    </th>
  );

  /* ── sector map ──────────────────────────────────── */
  const maxSectorRoles = Math.max(1, ...sectors.map((item) => item.openRoles));
  const totalOpenRoles = companies.reduce((sum, company) => sum + company.openJobCount, 0);
  const drilldown = sectors.find((item) => item.name === selectedSector) || null;
  const drilldownCompanies = useMemo(
    () => companies.filter((company) => company.sector === selectedSector).sort((a, b) => b.hiringScore - a.hiringScore),
    [companies, selectedSector]
  );

  /* ── modal plumbing ──────────────────────────────── */
  const activeJob = modal?.kind === "job" ? jobs.find((job) => job.id === modal.id) : undefined;
  const activeCompany = modal?.kind === "company" ? companies.find((item) => item.slug === modal.id) : undefined;
  const activeJobCompany = activeJob ? companyById.get(activeJob.companyId) : undefined;
  const backCompany = modal?.backTo ? companyBySlug.get(modal.backTo) : undefined;

  const scrollToJobs = () => jobsSection.current?.scrollIntoView({ block: "start" });

  return (
    <main>
      <div className="strip">
        <div className="wrap">
          <div className="strip-top">
            <h1>Startup jobs, <em>verified every day.</em></h1>
            <Link href="/about" className="strip-more">How this works →</Link>
          </div>
          <p>We recheck every company&apos;s own board once a day and write down exactly what moved.</p>
        </div>
      </div>

      <Ticker companies={companies} deltas={deltas} />

      {/* ══ OPEN JOBS ══ */}
      <section className="section" id="jobs" ref={jobsSection}>
        <div className="wrap">
          <div className="section-heading">
            <div>
              <h2>Open jobs</h2>
              <p>Found on the company&apos;s own board, not a repost. Click a role for the full record; click a company for everything they&apos;re hiring.</p>
            </div>
            <Link href="/api/v1/jobs" className="api-link">GET /api/v1/jobs</Link>
          </div>

          <div className="search-box">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
            </svg>
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(0); }}
              placeholder="Search role, company, department or city…"
              aria-label="Search jobs"
              autoComplete="off"
            />
            {query ? <button className="search-clear" type="button" onClick={() => { setQuery(""); setPage(0); }}>Clear</button> : null}
          </div>

          <div className="result-count">
            <span>
              <b>{visibleJobs.length}</b> role{visibleJobs.length === 1 ? "" : "s"} · {uniqueCompanies} compan{uniqueCompanies === 1 ? "y" : "ies"} on this page
              {filtersActive ? <button className="clear-filters" type="button" onClick={clearFilters}>Clear filters ✕</button> : null}
            </span>
            <span>Sorted by {SORT_LABELS[sort]}</span>
          </div>

          <div className="job-head job-cols">
            <span />
            <ColumnMenu
              label="Role"
              sortArrow={arrowFor(["title", "title_desc"])}
              filtering={Boolean(status)}
              groups={[
                sortGroup([["title", "Role A → Z"], ["title_desc", "Role Z → A"]]),
                {
                  heading: "Show",
                  options: [
                    { id: "status:", label: "All roles", selected: status === "" },
                    { id: "status:open", label: "Open only", selected: status === "open" },
                    { id: "status:closed", label: "Closed only", selected: status === "closed" },
                  ],
                },
              ]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Company"
              sortArrow={arrowFor(["company", "company_desc", "signal"])}
              groups={[sortGroup([["company", "Company A → Z"], ["company_desc", "Company Z → A"], ["signal", "Hiring signal, high → low"]])]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Sector" className="sector"
              sortArrow={arrowFor(["sector"])} filtering={Boolean(sector)}
              groups={[sortGroup([["sector", "Sector A → Z"]]), filterGroup("Filter by sector", "sector", sector, sectors.map((item) => item.name), "All sectors")]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Department" className="dept"
              sortArrow={arrowFor(["dept"])} filtering={Boolean(dept)}
              groups={[sortGroup([["dept", "Department A → Z"]]), filterGroup("Filter by department", "dept", dept, facets.departments, "All departments")]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Location"
              sortArrow={arrowFor(["loc"])} filtering={Boolean(loc)}
              groups={[sortGroup([["loc", "Location A → Z"]]), filterGroup("Filter by location", "loc", loc, facets.locations, "All locations")]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Comp"
              sortArrow={arrowFor(["comp_low", "comp_high"])}
              groups={[sortGroup([["comp_low", "Lowest first"], ["comp_high", "Highest first"]])]}
              onSelect={applyMenu}
            />
            <ColumnMenu
              label="Verified" className="end"
              sortArrow={arrowFor(["recent", "oldest"])}
              groups={[sortGroup([["recent", "Most recent first"], ["oldest", "Oldest first"]])]}
              onSelect={applyMenu}
            />
          </div>

          <div>
            {pageRows.length === 0 ? (
              <div className="empty-state">
                No roles match those filters. <button type="button" onClick={clearFilters}>Clear them</button>
              </div>
            ) : (
              pageRows.map((job) => {
                const company = companyById.get(job.companyId);
                const isOpen = job.status === "verified_open";
                return (
                  <div
                    key={job.id}
                    className={`job-row job-cols${isOpen ? "" : " closed"}`}
                  >
                    <span className="state" aria-hidden="true">{isOpen ? "■" : "□"}</span>
                    <button
                      type="button"
                      className="title"
                      aria-label={`${job.title} at ${company?.name}, ${isOpen ? "verified open" : "verified closed"}`}
                      onClick={() => setModal({ kind: "job", id: job.id })}
                    >
                      {job.title}
                    </button>
                    <span className="job-meta">
                      <button
                        type="button"
                        className="company-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (company) setModal({ kind: "company", id: company.slug });
                        }}
                      >
                        {company?.name}
                      </button>
                      <span className="sector" title={company?.industry}>{company?.sector}</span>
                      <span className="dept">{job.roleFamily}</span>
                      <span className="loc">{job.location}</span>
                      <span className="comp">{job.compensation}</span>
                    </span>
                    <span className="verified">{job.lastVerifiedAt.slice(5, 10)}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="pager">
            <span className="pager-status">
              {visibleJobs.length ? `Showing ${pageStart + 1}–${pageEnd} of ${visibleJobs.length}` : "0 results"}
            </span>
            <div className="pager-buttons">
              <button type="button" disabled={safePage === 0} onClick={() => { setPage(safePage - 1); scrollToJobs(); }}>← Prev</button>
              <span className="pager-page">Page {safePage + 1} / {pageCount}</span>
              <button type="button" className="primary" disabled={pageEnd >= visibleJobs.length} onClick={() => { setPage(safePage + 1); scrollToJobs(); }}>Next →</button>
            </div>
          </div>
        </div>
      </section>

      {/* ══ HIRING SIGNAL ══ */}
      <section className="section" id="signal">
        <div className="wrap">
          <div className="section-heading">
            <div><h2>Hiring signal</h2></div>
            <Link href="/api/v1/companies" className="api-link">GET /api/v1/companies</Link>
          </div>

          <div className="signal-definition">
            <div className="signal-line">
              <b>Hiring signal is a 0–100 directional measure of observed hiring momentum.</b>{" "}
              <InfoExplainer label="Hiring signal">
                <p>Open-role volume contributes up to 30 points, net open-role growth over 90 days up to 30, funding stage and recency up to 25, and board freshness up to 15. The total is capped at 100.</p>
              </InfoExplainer>
            </div>
            <div className="signal-line">
              It is a comparative indicator, not a probability. Confidence describes evidence quality, not the chance a prediction is right.{" "}
              <InfoExplainer label="Confidence">
                <p>Confidence combines verification recency (40 points), coverage of verified open roles (30), profile completeness (20), and an independent corroborating source (10).</p>
              </InfoExplainer>
              {" "}Green is net growth over the last 30 days and red is net contraction.
            </div>
          </div>

          <div className="sector-block" id="sector-map" ref={sectorSection}>
          <div className="map-bar">
            <span>Sector map · sized by open roles · 30-day change</span>
            <span>{sectors.length} sector{sectors.length === 1 ? "" : "s"} · {companies.length} companies · {totalOpenRoles} open roles</span>
          </div>
          <div className="sector-map">
            {sectors.map((stat) => {
              const direction = directionOf(stat.delta30d);
              const selected = selectedSector === stat.name;
              return (
                <button
                  key={stat.key}
                  type="button"
                  className={`sector-tile ${direction === "flat" ? "" : direction}${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => setSelectedSector(selected ? null : stat.name)}
                >
                  <span className="name">{stat.name}</span>
                  <span className="value">{stat.openRoles}</span>
                  <span className={`delta ${direction}`}>{arrowOf(stat.delta30d)} {signed(stat.delta30d)}</span>
                  <span className="share"><i style={{ width: `${Math.round((stat.openRoles / maxSectorRoles) * 100)}%` }} /></span>
                  <span className="foot">
                    {stat.share}% of market · {stat.companies} co
                    <span className="foot-extra"> · avg sig {stat.meanScore}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {drilldown ? (
            <div className="drilldown">
              <div className="drilldown-head">
                <h3>{drilldown.name}</h3>
                <p>{drilldown.companies} compan{drilldown.companies === 1 ? "y" : "ies"} · {drilldown.openRoles} open roles · avg signal {drilldown.meanScore}</p>
                <button className="go" type="button" onClick={() => { setSector(drilldown.name); setPage(0); scrollToJobs(); }}>Filter jobs →</button>
                <button className="close" type="button" onClick={() => setSelectedSector(null)}>Close ✕</button>
              </div>
              <div className="drilldown-list">
                {drilldownCompanies.map((company) => {
                  const delta = deltas[company.id] || 0;
                  return (
                    <button key={company.id} type="button" className="drill-row" onClick={() => setModal({ kind: "company", id: company.slug })}>
                      <span className="name">{company.name}</span>
                      <span className="stage">{company.stage}</span>
                      <span className="bar"><i style={{ width: `${company.hiringScore}%` }} /></span>
                      <span className="open">{company.openJobCount} open</span>
                      <span className={`delta ${directionOf(delta)}`}>{arrowOf(delta)}{signed(delta)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          </div>

          <div
            className="companies-block"
            id="companies"
            ref={companiesSection}
            data-testid="companies-list"
          >
          <div className="companies-head">
            <div>
              <h3>Companies and funding</h3>
              <p>All tracked companies, sorted by the selected measure. Ten records per page.</p>
            </div>
            <span>{sortedCompanies.length} companies</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {tableHeader("name", "Company")}
                  {tableHeader("sector", "Sector")}
                  {tableHeader("stage", "Stage")}
                  {tableHeader("funding", "Latest funding")}
                  {tableHeader("size", "Headcount")}
                  {tableHeader("open", "Open", true)}
                  {tableHeader("delta", "Δ 30d", true)}
                  {tableHeader("confidence", "Confidence", true)}
                  {tableHeader("score", "Signal", true)}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((company) => {
                  const delta = deltas[company.id] || 0;
                  return (
                    <tr
                      key={company.id}
                      tabIndex={0}
                      onClick={() => setModal({ kind: "company", id: company.slug })}
                      onKeyDown={(event) => { if (event.key === "Enter") setModal({ kind: "company", id: company.slug }); }}
                    >
                      <td>
                        <span className="cell-company">
                          <CompanyLogo domain={company.domain} name={company.name} />
                          <b>{company.name}</b>
                        </span>
                      </td>
                      <td className="dim" title={company.industry}>{company.sector}</td>
                      <td className="dim">{company.stage}</td>
                      <td className="mono">{company.latestFundingLabel}</td>
                      <td className="mono">{company.employeeRange}</td>
                      <td className="right mono">{company.openJobCount}</td>
                      <td className="right"><span className={`delta ${directionOf(delta)}`}>{arrowOf(delta)} {signed(delta)}</span></td>
                      <td className="right mono">{company.evidenceConfidence}</td>
                      <td className="right">
                        <span className="signal-cell">
                          <span className="bar"><i style={{ width: `${company.hiringScore}%` }} /></span>
                          <span className="mono">{company.hiringScore}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* phone rendering of the same rows — a list, not a squeezed table */}
          <div className="table-controls">
            <ColumnMenu
              label="Sort companies"
              sortArrow={tableSort.dir === -1 ? "↓" : "↑"}
              groups={[{
                heading: "Sort companies",
                options: PHONE_SORTS.map((preset) => ({
                  id: preset.id,
                  label: preset.label,
                  selected: tableSort.key === preset.key && tableSort.dir === preset.dir,
                })),
              }]}
              onSelect={(id) => {
                const preset = PHONE_SORTS.find((item) => item.id === id);
                if (preset) { setTableSort({ key: preset.key, dir: preset.dir }); setTablePage(0); }
              }}
            />
            <span className="current">{TABLE_LABELS[tableSort.key]} {tableSort.dir === -1 ? "↓" : "↑"}</span>
          </div>
          <div className="company-mobile-explainers" aria-label="Company score explanations">
            <span>
              Signal{" "}
              <InfoExplainer label="Hiring signal">
                <p>Open-role volume (30), 90-day net growth (30), funding stage and recency (25), and board freshness (15).</p>
              </InfoExplainer>
            </span>
            <span>
              Confidence{" "}
              <InfoExplainer label="Confidence">
                <p>Verification recency (40), coverage of verified open roles (30), profile completeness (20), and independent source corroboration (10).</p>
              </InfoExplainer>
            </span>
          </div>
          <div className="company-list">
            {tableRows.map((company) => {
              const delta = deltas[company.id] || 0;
              return (
                <button key={company.id} type="button" className="company-row" onClick={() => setModal({ kind: "company", id: company.slug })}>
                  <CompanyLogo domain={company.domain} name={company.name} />
                  <span className="names">
                    <b>{company.name}</b>
                    <span className="sub" title={`Source industry: ${company.industry}`}>{company.sector} · {company.stage} · {company.employeeRange}</span>
                  </span>
                  <span className="right">
                    <span className="score" aria-label={`Hiring signal ${company.hiringScore}`}>
                      <small>signal</small>{company.hiringScore}
                    </span>
                    <span className={`delta ${directionOf(delta)}`}>{arrowOf(delta)} {signed(delta)}</span>
                  </span>
                  <span className="foot">{company.openJobCount} open · confidence {company.evidenceConfidence} · {company.latestFundingLabel}</span>
                </button>
              );
            })}
          </div>

          <div className="pager">
            <span className="pager-status">
              {sortedCompanies.length ? `Showing ${tableStart + 1}–${tableEnd} of ${sortedCompanies.length} companies` : "0 companies"}
            </span>
            <div className="pager-buttons">
              <button type="button" disabled={safeTablePage === 0} onClick={() => { setTablePage(safeTablePage - 1); companiesSection.current?.scrollIntoView({ block: "start" }); }}>← Prev</button>
              <span className="pager-page">Page {safeTablePage + 1} / {tablePages}</span>
              <button type="button" className="primary" disabled={tableEnd >= sortedCompanies.length} onClick={() => { setTablePage(safeTablePage + 1); companiesSection.current?.scrollIntoView({ block: "start" }); }}>Next →</button>
            </div>
          </div>
          <div className="result-count">
            <span>Sorted by {TABLE_LABELS[tableSort.key]}, {tableSort.dir === -1 ? "high to low" : "low to high"}</span>
            <span>Click any row for the company record</span>
          </div>
          </div>

          <div
            className="market-movements"
            id="market-movements"
            ref={movementsSection}
            data-testid="market-movements"
          >
            <div className="market-movements-head">
              <div>
                <h3>Market movements</h3>
                <p>Verified openings and closures bundled into company and sector-level activity.</p>
              </div>
              <span>{movements.length} movement{movements.length === 1 ? "" : "s"}</span>
            </div>
            <div className="movement-list">
              {movementRows.length ? movementRows.map((movement) => (
                <button
                  key={movement.id}
                  type="button"
                  className="market-movement"
                  data-testid="market-movement"
                  onClick={() => {
                    if (movement.companySlug) {
                      setModal({ kind: "company", id: movement.companySlug });
                      return;
                    }
                    setSelectedSector(movement.sector);
                    sectorSection.current?.scrollIntoView({ block: "start" });
                  }}
                >
                  <time dateTime={movement.date}>{movement.date}</time>
                  <span className="movement-copy">
                    <b>{movement.title}</b>
                    <span>{movement.description}</span>
                    {movement.jobs.length ? (
                      <span className="movement-roles">
                        {movement.jobs.slice(0, 3).map((job) => job.title).join(" · ")}
                        {movement.jobs.length > 3 ? ` · +${movement.jobs.length - 3} more` : ""}
                      </span>
                    ) : null}
                  </span>
                  <span className={`movement-net ${directionOf(movement.netChange)}`}>
                    {arrowOf(movement.netChange)} {signed(movement.netChange)}
                    <small>{movement.evidenceCount} source{movement.evidenceCount === 1 ? "" : "s"}</small>
                  </span>
                  <span className="movement-open" aria-hidden="true">→</span>
                </button>
              )) : (
                <p className="movement-empty">No verified market movement in the current feed.</p>
              )}
            </div>
            {movements.length > MARKET_MOVEMENT_PAGE_SIZE ? (
              <div className="pager">
                <span className="pager-status">Showing {movementStart + 1}–{movementEnd} of {movements.length} movements</span>
                <div className="pager-buttons">
                  <button type="button" disabled={safeMovementPage === 0} onClick={() => { setMovementPage(safeMovementPage - 1); movementsSection.current?.scrollIntoView({ block: "start" }); }}>← Prev</button>
                  <span className="pager-page">Page {safeMovementPage + 1} / {movementPages}</span>
                  <button type="button" className="primary" disabled={movementEnd >= movements.length} onClick={() => { setMovementPage(safeMovementPage + 1); movementsSection.current?.scrollIntoView({ block: "start" }); }}>Next →</button>
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="changes"
            id="changes"
            ref={changesSection}
            data-testid="changes-list"
          >
            <div className="changes-head">
              <span>What changed</span>
              <Link href="/exports/daily-changes.json" className="api-link">daily-changes.json</Link>
            </div>
            {changeRows.map((change) => {
              const date = change.occurredAt.slice(0, 10);
              const company = companyForChange(change);
              const companyName = company?.name || "Company unavailable";
              return (
                <a
                  className={`change ${change.changeType}`}
                  key={change.id}
                  data-testid="change-item"
                  href={change.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open source for ${change.title} at ${companyName}`}
                >
                  <time dateTime={date}>
                    <span className="full-date">{date}</span>
                    <span className="short-date">{date.slice(5)}</span>
                  </time>
                  <span className="kind">{change.changeType.replaceAll("_", " ")}</span>
                  <span className="company">{companyName}</span>
                  <span className="title">{change.title}</span>
                  <span className="source">Open source ↗</span>
                </a>
              );
            })}
            <div className="pager">
              <span className="pager-status">
                {changes.length ? `Showing ${changeStart + 1}–${changeEnd} of ${changes.length} changes` : "0 changes"}
              </span>
              <div className="pager-buttons">
                <button
                  type="button"
                  disabled={safeChangePage === 0}
                  onClick={() => {
                    setChangePage(safeChangePage - 1);
                    changesSection.current?.scrollIntoView({ block: "start" });
                  }}
                >
                  ← Prev
                </button>
                <span className="pager-page">Page {safeChangePage + 1} / {changePages}</span>
                <button
                  type="button"
                  className="primary"
                  disabled={changeEnd >= changes.length}
                  onClick={() => {
                    setChangePage(safeChangePage + 1);
                    changesSection.current?.scrollIntoView({ block: "start" });
                  }}
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ HUMANS / AGENTS ══ */}
      <section className="section" id="access">
        <div className="wrap">
          <div className="section-heading">
            <div>
              <h2>Two ways to read this</h2>
              <p>The same records, published twice — once for people, once for machines. Neither is a downgrade of the other.</p>
            </div>
          </div>

          <div className="tabs" role="tablist">
            <button role="tab" type="button" aria-selected={tab === "humans"} onClick={() => setTab("humans")}>For humans</button>
            <button role="tab" type="button" aria-selected={tab === "agents"} onClick={() => setTab("agents")}>For agents</button>
          </div>

          {tab === "humans" ? (
            <div role="tabpanel">
              <p className="lead">
                One page, no account, no reposts. <span>If a role closes, we strike it through and keep it — we don&apos;t quietly delete it.</span>
              </p>
              <div className="points">
                <div className="point">
                  <span className="number">01</span><h4>Nothing to sign up for</h4>
                  <p>No account, no email wall. Search, filter and sort happen instantly in the page — nothing reloads.</p>
                </div>
                <div className="point">
                  <span className="number">02</span><h4>Every row carries a date</h4>
                  <p>You see when we last checked the employer&apos;s board, not when someone reposted it somewhere else.</p>
                </div>
                <div className="point">
                  <span className="number">03</span><h4>Links go to the source</h4>
                  <p>Straight to the employer&apos;s own posting. No middleman, no tracking redirect, no dead application form.</p>
                </div>
              </div>
              <div className="row-split">
                <div>
                  <div className="block-head">How a row gets here</div>
                  <dl className="recipe">
                    <div><dt>Run</dt><dd>Every day at <b>07:30 UTC</b></dd></div>
                    <div><dt>Method</dt><dd>Fetch the employer&apos;s own applicant tracking board</dd></div>
                    <div><dt>Sources</dt><dd><b>Ashby</b> and company careers pages</dd></div>
                    <div><dt>On change</dt><dd>Write a diff and keep the previous state</dd></div>
                    <div><dt>On stale</dt><dd>Mark it <b>unverified</b> — never guess</dd></div>
                  </dl>
                </div>
                <div>
                  <div className="block-head">What we deliberately don&apos;t do</div>
                  <dl className="recipe">
                    <div><dt>No reposts</dt><dd>If it isn&apos;t on the employer&apos;s board, it isn&apos;t here</dd></div>
                    <div><dt>No estimates</dt><dd>Compensation is quoted, or it says &ldquo;see posting&rdquo;</dd></div>
                    <div><dt>No deletions</dt><dd>Closed roles stay visible with the date they closed</dd></div>
                    <div><dt>No fees</dt><dd>Nobody can pay to move up this list</dd></div>
                    <div><dt>One indicator</dt><dd>Hiring signal — a reproducible measure built from observed activity and company facts</dd></div>
                  </dl>
                </div>
              </div>
            </div>
          ) : (
            <div role="tabpanel">
              <p className="lead">
                Stable JSON, incremental diffs, explicit state. <span>Every record says what it is and when we last checked, so an agent never has to infer either.</span>
              </p>
              <div className="points">
                <div className="point">
                  <span className="number">01</span><h4>State is explicit</h4>
                  <p>Every record carries <span className="mn">status</span> and <span className="mn">last_verified_at</span>. Absence never has to be interpreted.</p>
                </div>
                <div className="point">
                  <span className="number">02</span><h4>Diffs, not full pulls</h4>
                  <p>The changes feed reports what moved since the last run, so you fetch deltas instead of re-reading everything.</p>
                </div>
                <div className="point">
                  <span className="number">03</span><h4>No scraping required</h4>
                  <p>One public intelligence endpoint covers discovery and filtered reads; JSONL remains available for bulk copies. <span className="mn">llms.txt</span> describes the contract.</p>
                </div>
              </div>
              <div className="row-split">
                <div>
                  <div className="block-head">Preferred endpoint</div>
                  <div className="endpoints">
                    <Link className="endpoint preferred" href="/api/v1/intelligence"><span className="verb">GET</span><span>/api/v1/intelligence</span><span className="format">CAPS</span></Link>
                    <p className="endpoint-note">Use <span className="mn">view=jobs|companies|movements|sectors</span> with documented filters and cursors.</p>
                    <div className="compatibility-label">Compatibility and bulk exports</div>
                    <Link className="endpoint" href="/api/v1/companies"><span className="verb">GET</span><span>/api/v1/companies</span><span className="format">JSON</span></Link>
                    <Link className="endpoint" href="/api/v1/jobs"><span className="verb">GET</span><span>/api/v1/jobs</span><span className="format">JSON</span></Link>
                    <Link className="endpoint" href="/api/v1/changes"><span className="verb">GET</span><span>/api/v1/changes</span><span className="format">FEED</span></Link>
                    <Link className="endpoint" href="/exports/jobs.jsonl"><span className="verb">GET</span><span>/exports/jobs.jsonl</span><span className="format">JSONL</span></Link>
                    <Link className="endpoint" href="/exports/companies.jsonl"><span className="verb">GET</span><span>/exports/companies.jsonl</span><span className="format">JSONL</span></Link>
                    <Link className="endpoint" href="/llms.txt"><span className="verb">GET</span><span>/llms.txt</span><span className="format">TEXT</span></Link>
                  </div>
                </div>
                <div>
                  <div className="block-head">One record</div>
                  <pre>{`{
  "id": "${jobs[0]?.id ?? "job_example"}",
  "status": "${jobs[0]?.status ?? "verified_open"}",
  "last_verified_at": "${jobs[0]?.lastVerifiedAt ?? dataAsOf}",
  "first_seen_at": "${jobs[0]?.firstSeenAt ?? dataAsOf}",
  "source": "${jobs[0]?.source ?? "Ashby"}",
  "canonical_url": "${jobs[0]?.canonicalUrl ?? ""}"
}`}</pre>
                  <p className="note">Fields never change meaning between runs. New fields are added; existing ones are not repurposed.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {activeJob ? (
        <JobModal
          job={activeJob}
          company={activeJobCompany}
          backTo={backCompany?.name}
          onBack={() => modal?.backTo && setModal({ kind: "company", id: modal.backTo })}
          onOpenCompany={() => activeJobCompany && setModal({ kind: "company", id: activeJobCompany.slug })}
          onClose={() => setModal(null)}
        />
      ) : null}

      {activeCompany ? (
        <CompanyModal
          company={activeCompany}
          roles={jobs.filter((job) => job.companyId === activeCompany.id)}
          delta={deltas[activeCompany.id] || 0}
          onOpenJob={(jobId) => setModal({ kind: "job", id: jobId, backTo: activeCompany.slug })}
          onFilterToCompany={() => { setQuery(activeCompany.name); setPage(0); setModal(null); scrollToJobs(); }}
          onClose={() => setModal(null)}
        />
      ) : null}
    </main>
  );
}
