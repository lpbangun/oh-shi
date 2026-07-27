import type { ChangeEvent, Company, Job } from "./types";

export type HiringScoreInput = {
  openJobCount: number;
  openedLast90: number;
  closedLast90: number;
  stage: string;
  latestFundingDate: string | null;
  lastVerifiedAt: string;
  now: string;
};

export type EvidenceConfidenceInput = {
  openJobCount: number;
  freshlyVerifiedOpenCount: number;
  boardVerified: boolean;
  foundedYear: number | null;
  latestFundingDate: string | null;
  sourceUrl: string;
  careersUrl: string;
  lastVerifiedAt: string;
  now: string;
};

export const GROWTH_WINDOW_DAYS = 90;
export const HIRING_SCORE_METHODOLOGY_VERSION = "2026-07-27";
export const EVIDENCE_CONFIDENCE_METHODOLOGY_VERSION = "2026-07-27";

export type ScoreComponent = {
  name: string;
  points: number;
  max: number;
  input: Record<string, string | number | boolean | null>;
};

export type ScoreReceipt = {
  value: number;
  methodologyVersion: string;
  components: ScoreComponent[];
};

const STAGE_WEIGHTS: Record<string, number> = {
  seed: 0.6,
  "series a": 0.8,
  "series b": 0.9,
  "series c": 0.95,
  growth: 1,
};

const DEFAULT_STAGE_WEIGHT = 0.7;
const VOLUME_SATURATION = 12;
const NET_GROWTH_SATURATION = 6;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function daysSince(iso: string | null, now: string): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  const current = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(current)) return null;
  return (current - then) / 86_400_000;
}

function decay(days: number, fullUntil: number, zeroAt: number) {
  if (days <= fullUntil) return 1;
  if (days >= zeroAt) return 0;
  return (zeroAt - days) / (zeroAt - fullUntil);
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function openRoleVolumePoints(openJobCount: number) {
  const roles = Math.max(0, openJobCount);
  return 30 * Math.min(1, Math.log1p(roles) / Math.log1p(VOLUME_SATURATION));
}

export function openRoleGrowthPoints(openedLast90: number, closedLast90: number) {
  if (openedLast90 + closedLast90 === 0) return 9;
  const net = openedLast90 - closedLast90;
  return 15 * (1 + clamp(net / NET_GROWTH_SATURATION, -1, 1));
}

export function fundingStagePoints(stage: string, latestFundingDate: string | null, now: string) {
  const stageWeight = STAGE_WEIGHTS[stage.trim().toLowerCase()] ?? DEFAULT_STAGE_WEIGHT;
  const age = daysSince(latestFundingDate, now);
  let recency: number;
  if (age === null) recency = 0.6;
  else if (age <= 180) recency = 1;
  else if (age >= 540) recency = 0.4;
  else recency = 1 - 0.6 * ((age - 180) / 360);
  return 25 * stageWeight * recency;
}

export function boardFreshnessPoints(lastVerifiedAt: string, now: string) {
  const age = daysSince(lastVerifiedAt, now);
  if (age === null) return 0;
  return 15 * decay(Math.max(0, age), 2, 30);
}

function receipt(
  methodologyVersion: string,
  rawComponents: ScoreComponent[]
): ScoreReceipt {
  const rounded = rawComponents.map((component) => ({
    ...component,
    points: Math.round(component.points * 100) / 100,
  }));
  const value = Math.round(
    clamp(
      rawComponents.reduce((sum, component) => sum + component.points, 0),
      0,
      100
    )
  );
  const roundedTotalCents = rounded.reduce(
    (sum, component) => sum + Math.round(component.points * 100),
    0
  );
  let remainingCents = value * 100 - roundedTotalCents;
  for (const component of [...rounded].reverse()) {
    if (remainingCents === 0) break;
    const currentCents = Math.round(component.points * 100);
    const maxCents = Math.round(component.max * 100);
    const available =
      remainingCents > 0 ? maxCents - currentCents : currentCents;
    const applied =
      Math.sign(remainingCents) *
      Math.min(Math.abs(remainingCents), available);
    component.points = (currentCents + applied) / 100;
    remainingCents -= applied;
  }
  if (remainingCents !== 0) {
    throw new Error("Score receipt could not reconcile rounded components.");
  }
  return { value, methodologyVersion, components: rounded };
}

export function hiringScoreReceipt(input: HiringScoreInput): ScoreReceipt {
  return receipt(HIRING_SCORE_METHODOLOGY_VERSION, [
    {
      name: "Open role volume",
      points: openRoleVolumePoints(input.openJobCount),
      max: 30,
      input: { openJobCount: input.openJobCount },
    },
    {
      name: "90-day net role growth",
      points: openRoleGrowthPoints(input.openedLast90, input.closedLast90),
      max: 30,
      input: {
        openedLast90: input.openedLast90,
        closedLast90: input.closedLast90,
        windowDays: GROWTH_WINDOW_DAYS,
      },
    },
    {
      name: "Funding stage and recency",
      points: fundingStagePoints(input.stage, input.latestFundingDate, input.now),
      max: 25,
      input: { stage: input.stage, latestFundingDate: input.latestFundingDate },
    },
    {
      name: "Canonical board freshness",
      points: boardFreshnessPoints(input.lastVerifiedAt, input.now),
      max: 15,
      input: { lastVerifiedAt: input.lastVerifiedAt },
    },
  ]);
}

export function computeHiringScore(input: HiringScoreInput) {
  return hiringScoreReceipt(input).value;
}

export function evidenceConfidenceReceipt(input: EvidenceConfidenceInput): ScoreReceipt {
  const age = daysSince(input.lastVerifiedAt, input.now);
  const recency = age === null ? 0 : 40 * decay(Math.max(0, age), 2, 30);

  let coverage = 0;
  if (input.boardVerified) {
    coverage =
      input.openJobCount === 0
        ? 30
        : 30 * clamp(input.freshlyVerifiedOpenCount / input.openJobCount, 0, 1);
  }

  const completeness =
    (input.foundedYear !== null ? 5 : 0) +
    (input.latestFundingDate !== null ? 5 : 0) +
    (input.sourceUrl ? 5 : 0) +
    (input.careersUrl ? 5 : 0);

  const sourceHost = hostOf(input.sourceUrl);
  const careersHost = hostOf(input.careersUrl);
  const corroboration = sourceHost && careersHost && sourceHost !== careersHost ? 10 : 0;

  return receipt(EVIDENCE_CONFIDENCE_METHODOLOGY_VERSION, [
    {
      name: "Verification recency",
      points: recency,
      max: 40,
      input: { lastVerifiedAt: input.lastVerifiedAt },
    },
    {
      name: "Canonical board coverage",
      points: coverage,
      max: 30,
      input: {
        boardVerified: input.boardVerified,
        openJobCount: input.openJobCount,
        freshlyVerifiedOpenCount: input.freshlyVerifiedOpenCount,
      },
    },
    {
      name: "Company record completeness",
      points: completeness,
      max: 20,
      input: {
        foundedYear: input.foundedYear,
        latestFundingDate: input.latestFundingDate,
        hasSourceUrl: Boolean(input.sourceUrl),
        hasCareersUrl: Boolean(input.careersUrl),
      },
    },
    {
      name: "Independent source corroboration",
      points: corroboration,
      max: 10,
      input: {
        sourceHost,
        careersHost,
        independentHosts: Boolean(sourceHost && careersHost && sourceHost !== careersHost),
      },
    },
  ]);
}

export function computeEvidenceConfidence(input: EvidenceConfidenceInput) {
  return evidenceConfidenceReceipt(input).value;
}

/**
 * Build both published receipts directly from a company's canonical records.
 * `boardVerified` should reflect the current refresh attempt; it defaults to
 * true for stored snapshots whose `lastVerifiedAt` came from a tracked board.
 */
export function companyScoreReceipts(
  company: Company,
  jobs: Job[],
  changes: ChangeEvent[],
  now: string,
  boardVerified = true
) {
  const nowMs = Date.parse(now);
  const windowStart = nowMs - GROWTH_WINDOW_DAYS * 86_400_000;
  const companyJobs = jobs.filter((job) => job.companyId === company.id);
  const companyJobIds = new Set(companyJobs.map((job) => job.id));
  let openedLast90 = 0;
  let closedLast90 = 0;

  for (const change of changes) {
    if (!companyJobIds.has(change.entityId)) continue;
    const occurredAt = Date.parse(change.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < windowStart || occurredAt > nowMs) continue;
    if (change.changeType === "job_opened") openedLast90 += 1;
    if (change.changeType === "job_closed") closedLast90 += 1;
  }

  const openJobs = companyJobs.filter((job) => job.status === "verified_open");
  const freshCutoff = nowMs - 2 * 86_400_000;
  const freshlyVerifiedOpenCount = openJobs.filter((job) => {
    const verifiedAt = Date.parse(job.lastVerifiedAt);
    return Number.isFinite(verifiedAt) && verifiedAt >= freshCutoff && verifiedAt <= nowMs;
  }).length;
  const lastVerifiedAt =
    openJobs
      .map((job) => job.lastVerifiedAt)
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((a, b) => b.localeCompare(a))[0] || company.lastVerifiedAt;

  return {
    hiring: hiringScoreReceipt({
      openJobCount: openJobs.length,
      openedLast90,
      closedLast90,
      stage: company.stage,
      latestFundingDate: company.latestFundingDate,
      lastVerifiedAt,
      now,
    }),
    evidence: evidenceConfidenceReceipt({
      openJobCount: openJobs.length,
      freshlyVerifiedOpenCount,
      boardVerified,
      foundedYear: company.foundedYear,
      latestFundingDate: company.latestFundingDate,
      sourceUrl: company.sourceUrl,
      careersUrl: company.careersUrl,
      lastVerifiedAt,
      now,
    }),
  };
}
