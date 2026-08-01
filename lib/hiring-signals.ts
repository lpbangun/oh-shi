import { registrableDomain } from "./domain-registry";
import {
  HIRING_SIGNAL_SOURCE_KINDS,
  type HiringSignal,
  type HiringSignalSourceKind,
} from "./types";

export type HiringSignalImport = Omit<
  HiringSignal,
  "companyId" | "status" | "promotedJobId"
> & {
  companyId?: string | null;
};

const SOURCE_KINDS = new Set<string>(HIRING_SIGNAL_SOURCE_KINDS);
const PERMISSION_STATUSES = new Set([
  "permitted",
  "authorized",
  "manual_reviewed",
]);
const MAX_SIGNAL_LIFETIME_MS = 90 * 86_400_000;

function httpsUrl(value: string, optional = false) {
  if (optional && !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function iso(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function parseHiringSignalImport(
  value: unknown,
  now = new Date()
): { signal: HiringSignalImport | null; reason: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { signal: null, reason: "record must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const string = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  const id = string("id");
  const companyName = string("companyName");
  const companyDomain = registrableDomain(string("companyDomain"));
  const roleFunction = string("roleFunction");
  const summary = string("summary");
  const sourceKind = string("sourceKind") as HiringSignalSourceKind;
  const permissionStatus = string("permissionStatus") as HiringSignal["permissionStatus"];
  const sourceUrl = httpsUrl(string("sourceUrl"));
  const evidenceUrl = httpsUrl(string("evidenceUrl"));
  const sourceRightsUrl = httpsUrl(string("sourceRightsUrl"));
  const rawApplicationUrl = string("applicationUrl");
  const applicationUrl = rawApplicationUrl ? httpsUrl(rawApplicationUrl) : null;
  const observedAt = iso(string("observedAt"));
  const lastVerifiedAt = iso(string("lastVerifiedAt"));
  const expiresAt = iso(string("expiresAt"));
  const confidence = raw.confidence;
  const companyId = string("companyId") || null;

  if (!/^[a-z0-9][a-z0-9._:-]{2,159}$/i.test(id)) {
    return { signal: null, reason: "id must be a stable 3 to 160 character key" };
  }
  if (!companyName || companyName.length > 200 || !companyDomain) {
    return { signal: null, reason: "companyName and a registrable companyDomain are required" };
  }
  if (!roleFunction || roleFunction.length > 200 || !summary || summary.length > 1_000) {
    return { signal: null, reason: "roleFunction and summary are required" };
  }
  if (!SOURCE_KINDS.has(sourceKind) || !PERMISSION_STATUSES.has(permissionStatus)) {
    return { signal: null, reason: "sourceKind or permissionStatus is not allowed" };
  }
  if (!sourceUrl || !evidenceUrl || !sourceRightsUrl || (rawApplicationUrl && !applicationUrl)) {
    return { signal: null, reason: "source, evidence, rights, and optional application URLs must use HTTPS" };
  }
  if (
    !observedAt ||
    !lastVerifiedAt ||
    !expiresAt ||
    Date.parse(lastVerifiedAt) < Date.parse(observedAt) ||
    Date.parse(lastVerifiedAt) > now.valueOf() + 5 * 60_000 ||
    Date.parse(expiresAt) <= now.valueOf() ||
    Date.parse(expiresAt) - Date.parse(observedAt) > MAX_SIGNAL_LIFETIME_MS
  ) {
    return { signal: null, reason: "timestamps must describe a current signal expiring within 90 days" };
  }
  if (!Number.isInteger(confidence) || Number(confidence) < 0 || Number(confidence) > 100) {
    return { signal: null, reason: "confidence must be an integer from 0 to 100" };
  }
  return {
    signal: {
      id,
      companyId,
      companyName,
      companyDomain,
      roleFunction,
      summary,
      sourceKind,
      sourceUrl,
      evidenceUrl,
      sourceRightsUrl,
      applicationUrl: applicationUrl || null,
      permissionStatus,
      confidence: Number(confidence),
      observedAt,
      lastVerifiedAt,
      expiresAt,
    },
    reason: null,
  };
}
