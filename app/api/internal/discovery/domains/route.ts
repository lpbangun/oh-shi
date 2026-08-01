import { env } from "cloudflare:workers";
import {
  buildStartupDomainPilot,
  type DomainAcquisitionRelation,
  type DomainPermissionStatus,
  type StartupDomainEvidenceInput,
} from "@/lib/domain-registry";
import { persistStartupDomainPilot } from "@/lib/data";

export const dynamic = "force-dynamic";

const PERMISSIONS = new Set<DomainPermissionStatus>([
  "permitted",
  "manual_only",
  "awaiting_permission",
  "prohibited",
]);
const ACQUISITIONS = new Set<DomainAcquisitionRelation>(["acquired_from", "acquired_by"]);

const string = (value: unknown) => typeof value === "string" ? value : "";

function parseRecord(value: unknown): StartupDomainEvidenceInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const permissionStatus = string(raw.permissionStatus) as DomainPermissionStatus;
  if (
    !PERMISSIONS.has(permissionStatus) ||
    (permissionStatus === "permitted" && !string(raw.sourceTermsUrl)) ||
    (raw.activityState !== undefined && raw.activityState !== "unknown") ||
    (raw.reviewStatus !== undefined && raw.reviewStatus !== "pending")
  ) return null;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const relation = item as Record<string, unknown>;
      const aliasPermission = string(relation.permissionStatus) as DomainPermissionStatus;
      if (
        !PERMISSIONS.has(aliasPermission) ||
        (aliasPermission === "permitted" && !string(relation.sourceTermsUrl))
      ) return [];
      return [{
        aliasDomain: string(relation.aliasDomain),
        evidenceUrl: string(relation.evidenceUrl),
        permissionStatus: aliasPermission,
        sourceTermsUrl: relation.sourceTermsUrl === null
          ? undefined
          : string(relation.sourceTermsUrl),
        observedAt: string(relation.observedAt),
      }];
    })
    : [];
  const acquisitions = Array.isArray(raw.acquisitions)
    ? raw.acquisitions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const relation = string((item as Record<string, unknown>).relation) as DomainAcquisitionRelation;
      const acquisition = item as Record<string, unknown>;
      const acquisitionPermission =
        string(acquisition.permissionStatus) as DomainPermissionStatus;
      if (
        !ACQUISITIONS.has(relation) ||
        !PERMISSIONS.has(acquisitionPermission) ||
        (acquisitionPermission === "permitted" && !string(acquisition.sourceTermsUrl))
      ) return [];
      return [{
        relatedDomain: string(acquisition.relatedDomain),
        relation,
        evidenceUrl: string(acquisition.evidenceUrl),
        permissionStatus: acquisitionPermission,
        sourceTermsUrl: acquisition.sourceTermsUrl === null
          ? undefined
          : string(acquisition.sourceTermsUrl),
        observedAt: string(acquisition.observedAt),
      }];
    })
    : [];
  if (
    (raw.aliases !== undefined && !Array.isArray(raw.aliases)) ||
    (Array.isArray(raw.aliases) && aliases.length !== raw.aliases.length) ||
    (raw.acquisitions !== undefined && !Array.isArray(raw.acquisitions)) ||
    (Array.isArray(raw.acquisitions) && acquisitions.length !== raw.acquisitions.length) ||
    (raw.observedWebsiteUrls !== undefined && !Array.isArray(raw.observedWebsiteUrls))
  ) return null;
  return {
    companyName: string(raw.companyName),
    websiteUrl: string(raw.websiteUrl),
    observedWebsiteUrls: Array.isArray(raw.observedWebsiteUrls)
      ? raw.observedWebsiteUrls.filter(
        (item): item is string => typeof item === "string"
      )
      : [],
    aliases,
    acquisitions,
    sourceId: string(raw.sourceId),
    sourceKind: string(raw.sourceKind),
    sourceClassification: string(raw.sourceClassification),
    evidenceUrl: string(raw.evidenceUrl),
    permissionStatus,
    sourceTermsUrl: raw.sourceTermsUrl === null ? undefined : string(raw.sourceTermsUrl),
    observedAt: string(raw.observedAt),
    activityState: "unknown",
    reviewStatus: "pending",
  };
}

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json({ error: "Domain registry import is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${runtime.INGEST_TOKEN}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Body must be an object." }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  const cohort = string(payload.cohort).trim();
  const rawRecords = Array.isArray(payload.records) ? payload.records : [];
  if (!/^[a-z0-9][a-z0-9._-]{2,99}$/i.test(cohort)) {
    return Response.json({ error: "A stable pilot cohort is required." }, { status: 400 });
  }
  if (!rawRecords.length || rawRecords.length > 1_000) {
    return Response.json({ error: "Provide 1 to 1,000 evidence records." }, { status: 400 });
  }
  const records = rawRecords.map(parseRecord);
  if (records.some((record) => record === null)) {
    return Response.json({ error: "One or more evidence records are invalid." }, { status: 400 });
  }
  const pilot = buildStartupDomainPilot(
    records as StartupDomainEvidenceInput[],
    500,
    cohort
  );
  if (
    !pilot.receipt.reconciled ||
    pilot.receipt.rejectedRecords ||
    pilot.receipt.truncatedDomains ||
    !pilot.receipt.identityGraphValid
  ) {
    return Response.json(
      {
        error: "Evidence records failed registry validation.",
        receipt: pilot.receipt,
        identity_conflicts: pilot.identityConflicts,
      },
      { status: 400 }
    );
  }
  const persisted = await persistStartupDomainPilot(pilot.entries);
  return Response.json({
    cohort,
    receipt: pilot.receipt,
    persisted,
    activation: "none",
    note: "Registry candidates do not create companies, jobs, or hiring signals.",
  }, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
}
