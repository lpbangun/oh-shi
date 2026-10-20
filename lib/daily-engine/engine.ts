import type { CaptureRecorder } from "./capture";
import { validateReadinessManifest, type ReadinessManifest } from "./readiness";
import { domainsInBaseline, normalizeCandidateIdentity } from "./identity";
import { verifyHQ } from "./hq-verification";
import { stableId, verifyFunding } from "./funding-verification";
import { commitSource, readRecords, readSource, type Assessment, type SourceSnapshot } from "./persist";
import { TINYFISH_PREREQUISITE } from "./lanes/tinyfish";
import { sourceLane, type SourceUnit } from "./lanes/shared";
import type { CapCounter, EngineCounts, EngineRecord, EngineRunResult, LaneId, SourceReceipt } from "./types";

export const ENGINE_VERSION = "daily-engine-round2-v1";
export type Baseline = Parameters<typeof domainsInBaseline>[0];
export type DailyRun = EngineRunResult & {
  label: "FIXTURE" | "LIVE-BLOCKED" | "LIVE-READINESS" | "CAPTURED-ANNOUNCEMENTS";
  readinessManifest?: ReadinessManifest;
  captureEvidence?: CaptureRecorder["paths"];
  runId: string; revision: string; baselineId: string; inputId: string;
  novelty: "UNKNOWN-limited"; cost: "UNKNOWN";
  assessments: Assessment[];
  persistence: { companiesAdded: number; eventsAdded: number; checkpointsReused: number };
};
export async function runEngine(options: {
  lane: LaneId; sources: SourceUnit[]; baseline: Baseline; inputId: string;
  revision: string; now: string; fixtures: boolean; dryRun?: boolean;
  db?: D1Database; lookbackDays?: number; interruptAfterSources?: number;
  readinessManifest?: ReadinessManifest;
  capture?: CaptureRecorder;
}): Promise<DailyRun> {
  const readiness = options.readinessManifest ? validateReadinessManifest(options.readinessManifest, options.sources.filter(s => s.id.startsWith("official-")).map(s => s.id)) : undefined;
  if (readiness && options.lane === "direct" && !options.fixtures && options.sources.some(s => !readiness.lanes.direct.permittedSourceIds.includes(s.id))) throw new Error("readiness_source_not_authorized");
  if (!options.dryRun && !options.db) throw new Error("Local D1 store required unless dry-run");
  const startedAt = new Date().toISOString(), start = Date.now();
  const lookbackDays = options.lookbackDays ?? 14;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) throw new Error("lookback-days must be 1..365");
  const caps: CapCounter = { fetchRequests: 0, searchRequests: 0, maxFetchRequests: readiness?.authorizedCaps.maxFetchRequests ?? 100, maxSearchRequests: readiness?.authorizedCaps.maxSearchRequests ?? 40, deadlineAt: start + (readiness?.authorizedCaps.deadlineMsPerLane ?? 30 * 60_000), exceeded: false };
  const baselineId = stableId(JSON.stringify(options.baseline));
  const scope = stableId([ENGINE_VERSION, options.revision, options.lane, baselineId, options.inputId, readiness?.runId || options.now, lookbackDays].join(":"));
  const baseline = domainsInBaseline(options.baseline);
  const retained = options.db ? await readRecords(options.db) : [];
  const storedCompanies = options.db ? (await options.db.prepare("SELECT id,slug,name,domain,source_url AS sourceUrl,open_job_count AS openJobCount FROM companies").all<{ id: string; slug: string; name: string; domain: string; sourceUrl: string; openJobCount: number }>()).results : [];
  const existing = new Set([...retained.map(r => r.company.domain), ...storedCompanies.map(c => c.domain)]);
  const records = new Map<string, EngineRecord>();
  const assessments: Assessment[] = [], sourceReceipts: SourceReceipt[] = [], checkpoint: DailyRun["checkpoint"] = [];
  const persistence = { companiesAdded: 0, eventsAdded: 0, checkpointsReused: 0 };
  const seenCandidates = new Set<string>();
  let processed = 0;
  for (const source of options.sources) {
    const key = scope + ":" + source.id;
    const cached = options.db && !options.dryRun ? await readSource(options.db, key) : null;
    let snapshot: SourceSnapshot;
    if (cached?.receipt.status === "completed") {
      snapshot = cached; persistence.checkpointsReused++;
    } else {
      const before = caps.fetchRequests, searchBefore = caps.searchRequests;
      let receipt: SourceReceipt;
      let sourceAssessments: Assessment[] = [];
      try {
        if (source.permission !== "permitted") {
          receipt = { sourceId: source.id, lane: options.lane, status: "blocked", requests: 0, documentsChecked: 0, candidatesFound: 0,
            missingPrerequisite: source.missingPrerequisite || (source.id === "tinyfish-search-fetch" ? TINYFISH_PREREQUISITE : "Source access is " + source.permission + "; permission required before fetching.") };
        } else {
          const acquired = await sourceLane(source, options.lane).acquire({ capture: options.capture, lane: options.lane, now: options.now, lookbackDays, caps, checkpoint,
            existingCompanies: storedCompanies });
          receipt = acquired.receipts[0];
          sourceAssessments = acquired.candidates.map(candidate => {
            const identity = normalizeCandidateIdentity(candidate);
            if (!identity.ok || !identity.nameAgrees) return { candidate, domain: null, disposition: "unsupported" as const, reason: identity.ok ? "name_website_disagreement" : identity.reason, baselineKnown: false, hq: null, funding: null };
            const domain = identity.domain, baselineKnown = baseline.has(domain);
            const candidateKey = domain + ":" + candidate.evidenceUrl;
            if (seenCandidates.has(candidateKey)) return { candidate, domain, disposition: "duplicate" as const, reason: "same_company_evidence", baselineKnown, hq: null, funding: null };
            seenCandidates.add(candidateKey);
            const hq = verifyHQ(candidate, options.now);
            const funding = verifyFunding(candidate, domain, baselineKnown || existing.has(domain), options.now);
            if (candidate.announcementEvidence && hq.status !== "verified_us") return { candidate, domain, disposition: hq.status === "non_us" ? "non_us" as const : "unsupported" as const, reason: hq.reason || "independent_us_hq_required", baselineKnown, hq, funding: null };
            const disposition = funding.reason === "speculative" ? "speculative" as const :
              funding.reason ? "unsupported" as const : hq.status === "non_us" ? "non_us" as const :
              hq.status === "unknown" ? "pending_hq" as const : "accepted" as const;
            return { candidate, domain, disposition, reason: funding.reason, baselineKnown, hq, funding: funding.event };
          });
        }
      } catch (error) {
        receipt = { sourceId: source.id, lane: options.lane, status: "failed", requests: caps.fetchRequests - before + caps.searchRequests - searchBefore,
          documentsChecked: 0, candidatesFound: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
      snapshot = { receipt, assessments: sourceAssessments, completedAt: new Date().toISOString() };
    }
    for (const a of snapshot.assessments) {
      if (a.domain) seenCandidates.add(a.domain + ":" + a.candidate.evidenceUrl);
      if (!a.domain || !["accepted", "pending_hq"].includes(a.disposition)) continue;
      const c = a.candidate, prior = records.get(a.domain) || retained.find(r => r.company.domain === a.domain);
      if (a.funding) {
        const oldEvent = prior?.fundingEvents.find(e => e.id === a.funding!.id);
        a.funding.indexedAt = oldEvent?.indexedAt || (options.dryRun ? undefined : startedAt);
        if (oldEvent) a.funding.discoveredAt = oldEvent.discoveredAt;
        else if (c.announcementEvidence) a.funding.discoveredAt = c.announcementEvidence.capturedAt;
      }
      const fundingEvents = [...new Map([...(prior?.fundingEvents || []), ...(a.funding ? [a.funding] : [])].map(e => [e.id, e])).values()];
      const latest = fundingEvents.filter(e => e.occurredAt).sort((x,y) => y.occurredAt.localeCompare(x.occurredAt))[0];
      const verified = prior?.company.hqStatus === "verified_us";
      const hqCapture = c.headquartersDocuments?.find(d => d.url === (verified ? prior!.company.hqEvidenceUrl : a.hq?.evidenceUrl));
      records.set(a.domain, {
        isNewCompany: c.announcementEvidence
          ? prior && a.funding && prior.fundingEvents.some(e => e.id === a.funding!.id)
            ? prior.isNewCompany : !a.baselineKnown && !existing.has(a.domain)
          : !a.baselineKnown,
        company: { id: prior?.company.id || storedCompanies.find(c => c.domain === a.domain)?.id || "daily_" + stableId(a.domain), slug: prior?.company.slug || storedCompanies.find(c => c.domain === a.domain)?.slug || a.domain.replace(/[^a-z0-9]/g, "-"),
          name: c.companyName, domain: a.domain, description: "", headquarters: verified ? prior!.company.headquarters : a.hq?.matchedText || "",
          hqStatus: verified ? "verified_us" : a.hq!.status, hqEvidenceUrl: verified ? prior!.company.hqEvidenceUrl : a.hq!.evidenceUrl,
          hqMethod: a.hq!.method,
          hqCapture: hqCapture ? { capturedAt: hqCapture.capturedAt, sha256: hqCapture.sha256 } : prior?.company.hqCapture,
          foundedYear: null, employeeRange: "", industry: "", stage: latest?.stage || "",
          fundingMode: "", lifecycleStatus: "unknown", latestFundingLabel: latest?.latestFundingLabel || "",
          latestFundingDate: latest?.occurredAt || null, careersUrl: "", sourceUrl: c.evidenceUrl, evidenceUrl: c.evidenceUrl,
          openJobCount: prior?.company.openJobCount ?? storedCompanies.find(c => c.domain === a.domain)?.openJobCount ?? 0,
          discoveredAt: prior?.company.discoveredAt || c.announcementEvidence?.capturedAt || options.now,
          indexedAt: prior?.company.indexedAt || (options.dryRun ? undefined : startedAt), lastCheckedAt: options.now, lane: options.lane },
        fundingEvents,
      });
    }
    assessments.push(...snapshot.assessments);
    sourceReceipts.push(snapshot.receipt);
    if (snapshot.receipt.status === "completed") checkpoint.push({ sourceId: source.id, cursor: key, status: "completed", completedAt: snapshot.completedAt });
    if (cached?.receipt.status !== "completed" && !options.dryRun && options.db) {
      const added = await commitSource(options.db, key, snapshot, [...records.values()]);
      persistence.companiesAdded += added.companies; persistence.eventsAdded += added.events;
    }
    processed++;
    if (options.interruptAfterSources === processed) throw new Error("simulated_interruption_after_atomic_checkpoint");
  }
  const all = [...records.values()];
  const domains = new Set(assessments.flatMap(a => a.domain ? [a.domain] : []));
  const uniqueFunding = [...new Map(assessments.flatMap(a => a.funding && ["accepted", "pending_hq"].includes(a.disposition) ? [[a.funding.id,a.funding] as const] : [])).values()];
  const verifiedDomains = new Set(all.filter(r => r.company.hqStatus === "verified_us").map(r => r.company.domain));
  const pendingDomains = new Set(all.filter(r => r.company.hqStatus === "unknown").map(r => r.company.domain));
  const verifiedFunding = uniqueFunding.filter(e => verifiedDomains.has(e.companyDomain));
  const counts: EngineCounts = {
    candidatesAcquired: assessments.length, distinctDomains: domains.size,
    duplicatesSkipped: assessments.filter(a => a.disposition === "duplicate").length,
    baselineKnownSkipped: new Set(assessments.filter(a => a.baselineKnown).map(a => a.domain)).size,
    usHqVerified: all.filter(r => r.company.hqStatus === "verified_us").length,
    usHqUnknown: all.filter(r => r.company.hqStatus === "unknown").length,
    nonUsExcluded: new Set(assessments.filter(a => a.disposition === "non_us").map(a => a.domain)).size,
    newCompaniesPersisted: options.dryRun ? 0 : all.filter(r => r.isNewCompany && r.company.hqStatus === "verified_us" && !existing.has(r.company.domain)).length,
    fundingEventsNewCompanies: uniqueFunding.filter(e => !e.companyExisting).length,
    fundingEventsExistingCompanies: uniqueFunding.filter(e => e.companyExisting).length,
    verifiedFundingEventsNewCompanies: verifiedFunding.filter(e => !e.companyExisting).length,
    verifiedFundingEventsExistingCompanies: verifiedFunding.filter(e => e.companyExisting).length,
    pendingHqFundingEvents: uniqueFunding.filter(e => pendingDomains.has(e.companyDomain)).length,
    fundingEventsWithoutDate: uniqueFunding.filter(e => !e.occurredAt).length,
    speculativeExcluded: assessments.filter(a => a.disposition === "speculative").length,
    falsePositivesExcluded: assessments.filter(a => a.disposition === "unsupported").length,
  };
  return {
    engineVersion: ENGINE_VERSION, lane: options.lane, label: options.fixtures ? "FIXTURE" : readiness ? "LIVE-READINESS" : options.sources.length > 0 && options.sources.every(s => s.id.startsWith("announcement-")) ? "CAPTURED-ANNOUNCEMENTS" : "LIVE-BLOCKED",
    ...(readiness ? { readinessManifest: readiness } : {}),
    ...(options.capture ? { captureEvidence: options.capture.paths } : {}),
    runId: readiness ? readiness.runId + "-" + options.lane : stableId(scope + startedAt + Math.random()), revision: options.revision, inputId: options.inputId, baselineId,
    novelty: "UNKNOWN-limited", cost: "UNKNOWN", dryRun: !!options.dryRun, startedAt, completedAt: new Date().toISOString(), lookbackDays,
    counts, caps: { fetchRequests: caps.fetchRequests, searchRequests: caps.searchRequests, fetchCap: caps.maxFetchRequests, searchCap: caps.maxSearchRequests, deadlineHit: caps.exceeded, elapsedMs: Date.now() - start },
    stageReceipts: (["acquire","identity","us_hq","funding","persist","report"] as const).map(stage => ({
      stage, ok: stage !== "acquire" || !sourceReceipts.some(r => r.status !== "completed"),
      detail: stage === "persist" ? options.dryRun ? "dry_run_no_writes" : "local_D1_atomic_per_source" : "shared_core",
      errors: stage === "acquire" ? sourceReceipts.flatMap(r => r.error || r.missingPrerequisite ? [r.error || r.missingPrerequisite!] : []) : [],
    })),
    sourceReceipts, records: all, checkpoint, assessments, persistence,
  };
}
