import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalEndpoint } from "./ats-adapters";
import type { AtsProvider } from "./source-registry";

/** Gate 1 reviewed employer pack row. Required fields are first-class for Gate 2 ingest. */
export type EdtechPackRow = {
  name: string;
  website: string;
  provider: Exclude<AtsProvider, "manual" | "structured">;
  board_id: string;
  evidence_url: string;
  vertical: "edtech";
  employer_kind?: string;
};

export type EdtechPack = {
  schemaVersion: "1.0";
  vertical: "edtech";
  generatedAt: string;
  reviewRule: string;
  attribution: {
    lastround: string;
    lastroundLicense: string;
    lastroundUrl: string;
    wikidata?: string;
  };
  rows: EdtechPackRow[];
};

export const EDTECH_PACK_PATH = path.join(process.cwd(), "packs", "edtech.json");

export const KNOWN_ATS_API_HOSTS = [
  "boards-api.greenhouse.io",
  "api.lever.co",
  "api.ashbyhq.com",
  "www.workable.com",
  "api.smartrecruiters.com",
] as const;

export const DISALLOWED_PACK_HOSTS = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "www.edtech.com",
  "edtech.com",
  "wellfound.com",
  "crunchbase.com",
] as const;

const PACK_PROVIDERS: ReadonlySet<EdtechPackRow["provider"]> = new Set([
  "ashby",
  "greenhouse",
  "lever",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
]);

const REQUIRED_FIELDS = ["name", "website", "provider", "board_id", "evidence_url"] as const;

export function evidenceUrlFor(provider: EdtechPackRow["provider"], boardId: string) {
  return canonicalEndpoint(provider, boardId);
}

export function isKnownAtsApiHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (KNOWN_ATS_API_HOSTS.includes(host as typeof KNOWN_ATS_API_HOSTS[number])) {
    return true;
  }
  if (/^[a-z0-9-]+\.recruitee\.com$/i.test(host)) return true;
  if (/^[a-z0-9-]+\.jobs\.personio\.(?:de|com)$/i.test(host)) return true;
  return false;
}

export function containsDisallowedHost(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return DISALLOWED_PACK_HOSTS.some((disallowed) =>
      host === disallowed || host.endsWith(`.${disallowed}`)
    );
  } catch {
    return false;
  }
}

export function parseEdtechPack(payload: unknown): EdtechPack {
  const root = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const rows = Array.isArray(root.rows) ? root.rows : [];
  return {
    schemaVersion: "1.0",
    vertical: "edtech",
    generatedAt: String(root.generatedAt || ""),
    reviewRule: String(root.reviewRule || ""),
    attribution: {
      lastround: String(object(root.attribution).lastround || ""),
      lastroundLicense: String(object(root.attribution).lastroundLicense || ""),
      lastroundUrl: String(object(root.attribution).lastroundUrl || ""),
      wikidata: object(root.attribution).wikidata
        ? String(object(root.attribution).wikidata)
        : undefined,
    },
    rows: rows.map((row) => normalizeRow(row)),
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizeRow(raw: unknown): EdtechPackRow {
  const row = object(raw);
  const provider = String(row.provider || "").trim() as EdtechPackRow["provider"];
  const boardId = String(row.board_id || "").trim();
  return {
    name: String(row.name || "").trim(),
    website: String(row.website || "").trim(),
    provider,
    board_id: boardId,
    evidence_url: String(row.evidence_url || evidenceUrlFor(provider, boardId)).trim(),
    vertical: "edtech",
    employer_kind: row.employer_kind ? String(row.employer_kind).trim() : undefined,
  };
}

export async function loadEdtechPack(filePath = EDTECH_PACK_PATH) {
  const payload = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return parseEdtechPack(payload);
}

export type EdtechPackValidationIssue = {
  code: string;
  message: string;
  index?: number;
};

export function validateEdtechPack(pack: EdtechPack): EdtechPackValidationIssue[] {
  const issues: EdtechPackValidationIssue[] = [];
  const seen = new Set<string>();

  for (const [index, row] of pack.rows.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (!row[field]) {
        issues.push({
          code: "missing_field",
          message: `Row ${index} is missing ${field}`,
          index,
        });
      }
    }
    if (row.vertical !== "edtech") {
      issues.push({
        code: "vertical",
        message: `Row ${index} must set vertical to edtech`,
        index,
      });
    }
    if (!PACK_PROVIDERS.has(row.provider)) {
      issues.push({
        code: "provider",
        message: `Row ${index} has unsupported provider ${row.provider}`,
        index,
      });
    }
    for (const url of [row.website, row.evidence_url]) {
      if (!/^https:\/\//.test(url)) {
        issues.push({
          code: "https",
          message: `Row ${index} URL must be HTTPS: ${url}`,
          index,
        });
      }
      if (containsDisallowedHost(url)) {
        issues.push({
          code: "disallowed_host",
          message: `Row ${index} references disallowed host: ${url}`,
          index,
        });
      }
    }
    try {
      const host = new URL(row.evidence_url).hostname;
      if (!isKnownAtsApiHost(host)) {
        issues.push({
          code: "evidence_host",
          message: `Row ${index} evidence_url host is not a known ATS API host: ${host}`,
          index,
        });
      }
    } catch {
      issues.push({
        code: "evidence_url",
        message: `Row ${index} evidence_url is not a valid URL`,
        index,
      });
    }
    const key = `${row.provider}:${row.board_id.toLowerCase()}`;
    if (seen.has(key)) {
      issues.push({
        code: "duplicate_board",
        message: `Duplicate provider+board_id: ${key}`,
        index,
      });
    }
    seen.add(key);
    const expected = evidenceUrlFor(row.provider, row.board_id);
    if (row.evidence_url !== expected) {
      issues.push({
        code: "evidence_mismatch",
        message: `Row ${index} evidence_url must match canonical endpoint`,
        index,
      });
    }
  }

  return issues;
}

export function assertValidEdtechPack(pack: EdtechPack) {
  const issues = validateEdtechPack(pack);
  if (issues.length) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
}
