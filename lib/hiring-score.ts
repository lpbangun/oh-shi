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

export function computeHiringScore(input: HiringScoreInput) {
  const total =
    openRoleVolumePoints(input.openJobCount) +
    openRoleGrowthPoints(input.openedLast90, input.closedLast90) +
    fundingStagePoints(input.stage, input.latestFundingDate, input.now) +
    boardFreshnessPoints(input.lastVerifiedAt, input.now);
  return Math.round(clamp(total, 0, 100));
}

export function computeEvidenceConfidence(input: EvidenceConfidenceInput) {
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

  return Math.round(clamp(recency + coverage + completeness + corroboration, 0, 100));
}
