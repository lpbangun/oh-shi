import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ATS_ADAPTER_VERSION,
  ATS_DETECTION_VERSION,
  fetchCanonicalBoard,
} from "../lib/ats-adapters";
import {
  CANONICAL_SOURCE_PROBE_USER_AGENT,
  CANONICAL_SOURCE_PROBE_VERSION,
  probeCanonicalSource,
  type CanonicalSourceProbePage,
  type ExternalCareerLinkEvidence,
} from "../lib/canonical-source-discovery";
import { registrableDomain } from "../lib/domain-registry";
import { STRUCTURED_CAREER_ADAPTER_VERSION } from "../lib/structured-career-page";

export type PilotRecord = {
  companyName?: string;
  websiteUrl?: string;
  sourceId?: string;
  sourceClassification?: string;
  permissionStatus?: string;
  reviewStatus?: string;
};

export type PilotArtifact = {
  schemaVersion?: string;
  cohort?: string;
  generatedAt?: string;
  records?: PilotRecord[];
};

export type PilotInput = {
  inputIndex: number;
  domain: string;
  companyName: string;
  websiteUrl: string;
  sourceClassification: string;
  sourceIds: string[];
};

export type YieldProbeConfig = {
  includeStructured: boolean;
  maxPages: number;
  structuredMaxPages: number;
  structuredMaxDepth: 1;
  atsAdapterVersion: string;
  atsDetectionVersion: string;
  structuredAdapterVersion: string;
  canonicalSourceProbeVersion: string;
  userAgent: string;
  implementationHash: string;
  asOf: string;
};

export type YieldReceipt = {
  schemaVersion: "1.1";
  inputHash: string;
  probeConfigHash: string;
  probeConfig: YieldProbeConfig;
  cohort: string;
  inputIndex: number;
  domain: string;
  companyName: string;
  websiteUrl: string;
  sourceClassification: string;
  sourceIds: string[];
  attempt: number;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  detectionStatus: "single" | "ambiguous" | "structured" | "none" | "probe_error";
  provider: string | null;
  boardId: string | null;
  careersUrl: string | null;
  candidates: unknown[];
  pages: CanonicalSourceProbePage[];
  externalCareerLinks: ExternalCareerLinkEvidence[];
  probeDisposition:
    | "source_detected"
    | "no_source_on_reachable_pages"
    | "all_http_error"
    | "all_off_site_redirect"
    | "all_robots_or_network_error"
    | "all_probe_pages_failed_mixed"
    | "probe_error";
  fetchedPages: number;
  failedPages: number;
  structuredError: string | null;
  canonicalFetchStatus:
    | "not_attempted"
    | "complete"
    | "http_error"
    | "rate_limited"
    | "timeout"
    | "incomplete"
    | "fetch_error";
  canonicalObservedOpenings: number | null;
  canonicalUsVerifiedJobs: number;
  canonicalZeroUs: boolean;
  verifiedStatus: "verified_us_jobs" | "verified_zero_us" | "unverified";
  error: string | null;
};

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function canonicalInputs(artifact: PilotArtifact) {
  const merged = new Map<string, Omit<PilotInput, "inputIndex">>();
  for (const record of artifact.records || []) {
    if (record.reviewStatus !== "pending" || record.permissionStatus !== "permitted") continue;
    const websiteUrl = record.websiteUrl?.trim() || "";
    const domain = registrableDomain(websiteUrl);
    if (!domain || !websiteUrl.startsWith("https://")) continue;
    const current = merged.get(domain) || {
      domain,
      companyName: record.companyName?.trim() || domain,
      websiteUrl,
      sourceClassification: record.sourceClassification || "unknown",
      sourceIds: [],
    };
    if (record.sourceClassification === "explicit_startup") {
      current.sourceClassification = "explicit_startup";
    }
    if (record.sourceId) current.sourceIds.push(record.sourceId);
    merged.set(domain, current);
  }
  return [...merged.values()]
    .sort((left, right) => left.domain.localeCompare(right.domain))
    .map((input, inputIndex) => ({
      ...input,
      inputIndex,
      sourceIds: [...new Set(input.sourceIds)].sort(),
    }));
}

function receiptErrorStatus(error: unknown): YieldReceipt["canonicalFetchStatus"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate.?limit/i.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/incomplete payload|invalid|parse|non-(?:json|xml)/i.test(message)) return "incomplete";
  if (/\bHTTP?\s*[45]\d\d\b|returned [45]\d\d/i.test(message)) return "http_error";
  return "fetch_error";
}

async function measure(
  input: PilotInput,
  inputHash: string,
  probeConfigHash: string,
  probeConfig: YieldProbeConfig,
  cohort: string,
  attempt: number
): Promise<YieldReceipt> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const base = {
    schemaVersion: "1.1" as const,
    inputHash,
    probeConfigHash,
    probeConfig,
    cohort,
    inputIndex: input.inputIndex,
    domain: input.domain,
    companyName: input.companyName,
    websiteUrl: input.websiteUrl,
    sourceClassification: input.sourceClassification,
    sourceIds: input.sourceIds,
    attempt,
    startedAt,
  };
  try {
    const probe = await probeCanonicalSource(input.websiteUrl, {
      includeStructured: probeConfig.includeStructured,
      maxPages: probeConfig.maxPages,
      structuredMaxPages: probeConfig.structuredMaxPages,
      structuredMaxDepth: probeConfig.structuredMaxDepth,
      asOf: probeConfig.asOf,
    });
    const fetchedPages = probe.pages.filter((page) => page.status === "fetched").length;
    const failedPages = probe.pages.length - fetchedPages;
    const pageStatuses = new Set(probe.pages.map((page) => page.status));
    const probeDisposition = probe.detection || probe.candidates.length
      ? "source_detected" as const
      : fetchedPages
        ? "no_source_on_reachable_pages" as const
        : pageStatuses.size === 1 && pageStatuses.has("http_error")
          ? "all_http_error" as const
          : pageStatuses.size === 1 && pageStatuses.has("off_site_redirect")
            ? "all_off_site_redirect" as const
            : pageStatuses.size === 1 && pageStatuses.has("robots_or_network_error")
              ? "all_robots_or_network_error" as const
              : "all_probe_pages_failed_mixed" as const;
    if (!probe.detection) {
      return {
        ...base,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        detectionStatus: probe.detectionStatus,
        provider: null,
        boardId: null,
        careersUrl: null,
        candidates: probe.candidates,
        pages: probe.pages,
        externalCareerLinks: probe.externalCareerLinks,
        probeDisposition,
        fetchedPages,
        failedPages,
        structuredError: probe.structuredError,
        canonicalFetchStatus: "not_attempted",
        canonicalObservedOpenings: null,
        canonicalUsVerifiedJobs: 0,
        canonicalZeroUs: false,
        verifiedStatus: "unverified",
        error: probe.structuredError,
      };
    }
    try {
      const canonical = await fetchCanonicalBoard(
        probe.detection.provider,
        probe.detection.boardId
      );
      const uniqueJobs = new Set(canonical.jobs.map((job) => job.externalId));
      return {
        ...base,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        detectionStatus: probe.detectionStatus,
        provider: probe.detection.provider,
        boardId: probe.detection.boardId,
        careersUrl: probe.detection.careersUrl,
        candidates: probe.candidates,
        pages: probe.pages,
        externalCareerLinks: probe.externalCareerLinks,
        probeDisposition,
        fetchedPages,
        failedPages,
        structuredError: probe.structuredError,
        canonicalFetchStatus: "complete",
        canonicalObservedOpenings: canonical.observedJobs?.length ?? null,
        canonicalUsVerifiedJobs: uniqueJobs.size,
        canonicalZeroUs: uniqueJobs.size === 0,
        verifiedStatus: uniqueJobs.size ? "verified_us_jobs" : "verified_zero_us",
        error: null,
      };
    } catch (error) {
      return {
        ...base,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        detectionStatus: probe.detectionStatus,
        provider: probe.detection.provider,
        boardId: probe.detection.boardId,
        careersUrl: probe.detection.careersUrl,
        candidates: probe.candidates,
        pages: probe.pages,
        externalCareerLinks: probe.externalCareerLinks,
        probeDisposition,
        fetchedPages,
        failedPages,
        structuredError: probe.structuredError,
        canonicalFetchStatus: receiptErrorStatus(error),
        canonicalObservedOpenings: null,
        canonicalUsVerifiedJobs: 0,
        canonicalZeroUs: false,
        verifiedStatus: "unverified",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
    }
  } catch (error) {
    return {
      ...base,
      completedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      detectionStatus: "probe_error",
      provider: null,
      boardId: null,
      careersUrl: null,
      candidates: [],
      pages: [],
      externalCareerLinks: [],
      probeDisposition: "probe_error",
      fetchedPages: 0,
      failedPages: 0,
      structuredError: null,
      canonicalFetchStatus: "not_attempted",
      canonicalObservedOpenings: null,
      canonicalUsVerifiedJobs: 0,
      canonicalZeroUs: false,
      verifiedStatus: "unverified",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}

export function aggregateYield(
  inputs: PilotInput[],
  receipts: YieldReceipt[],
  inputHash: string,
  probeConfigHash: string,
  cohort: string
) {
  const current = new Map<string, YieldReceipt>();
  for (const receipt of receipts) {
    if (
      receipt.inputHash !== inputHash ||
      receipt.probeConfigHash !== probeConfigHash
    ) continue;
    const previous = current.get(receipt.domain);
    if (!previous || receipt.attempt >= previous.attempt) current.set(receipt.domain, receipt);
  }
  const values = [...current.values()].sort((left, right) => left.inputIndex - right.inputIndex);
  const byProvider: Record<string, {
    detectedCompanies: number;
    completeCompanies: number;
    verifiedUsCompanies: number;
    verifiedUsJobs: number;
  }> = {};
  const byClassification: Record<string, {
    inputDomains: number;
    measuredCompanies: number;
    detectedCompanies: number;
    completeCompanies: number;
    verifiedUsCompanies: number;
    verifiedUsJobs: number;
  }> = {};
  for (const input of inputs) {
    const classification = byClassification[input.sourceClassification] ||= {
      inputDomains: 0,
      measuredCompanies: 0,
      detectedCompanies: 0,
      completeCompanies: 0,
      verifiedUsCompanies: 0,
      verifiedUsJobs: 0,
    };
    classification.inputDomains += 1;
  }
  for (const receipt of values) {
    const classification = byClassification[receipt.sourceClassification] ||= {
      inputDomains: 0,
      measuredCompanies: 0,
      detectedCompanies: 0,
      completeCompanies: 0,
      verifiedUsCompanies: 0,
      verifiedUsJobs: 0,
    };
    classification.measuredCompanies += 1;
    if (receipt.provider) classification.detectedCompanies += 1;
    if (receipt.canonicalFetchStatus === "complete") {
      classification.completeCompanies += 1;
    }
    if (receipt.verifiedStatus === "verified_us_jobs") {
      classification.verifiedUsCompanies += 1;
    }
    classification.verifiedUsJobs += receipt.canonicalUsVerifiedJobs;
    if (!receipt.provider) continue;
    const provider = byProvider[receipt.provider] ||= {
      detectedCompanies: 0,
      completeCompanies: 0,
      verifiedUsCompanies: 0,
      verifiedUsJobs: 0,
    };
    provider.detectedCompanies += 1;
    if (receipt.canonicalFetchStatus === "complete") provider.completeCompanies += 1;
    if (receipt.verifiedStatus === "verified_us_jobs") provider.verifiedUsCompanies += 1;
    provider.verifiedUsJobs += receipt.canonicalUsVerifiedJobs;
  }
  const failures: Record<string, number> = {};
  const probeOutcomes: Record<string, number> = {};
  const unsupportedHosts = new Map<string, {
    domains: Set<string>;
    evidencePages: Set<string>;
    occurrences: number;
    signals: Set<ExternalCareerLinkEvidence["signals"][number]>;
    sampleUrls: Set<string>;
  }>();
  for (const receipt of values) {
    probeOutcomes[receipt.probeDisposition] =
      (probeOutcomes[receipt.probeDisposition] || 0) + 1;
    for (const evidence of receipt.externalCareerLinks) {
      const current = unsupportedHosts.get(evidence.host) || {
        domains: new Set<string>(),
        evidencePages: new Set<string>(),
        occurrences: 0,
        signals: new Set<ExternalCareerLinkEvidence["signals"][number]>(),
        sampleUrls: new Set<string>(),
      };
      current.domains.add(receipt.domain);
      for (const page of evidence.evidencePages) current.evidencePages.add(page);
      current.occurrences += evidence.occurrenceCount;
      for (const signal of evidence.signals) current.signals.add(signal);
      for (const url of evidence.sampleUrls) {
        if (current.sampleUrls.size < 3) current.sampleUrls.add(url);
      }
      unsupportedHosts.set(evidence.host, current);
    }
    if (!receipt.error) continue;
    const key = receipt.canonicalFetchStatus === "not_attempted"
      ? receipt.probeDisposition
      : receipt.canonicalFetchStatus;
    failures[key] = (failures[key] || 0) + 1;
  }
  const unsupportedCareerHostLeads = [...unsupportedHosts].map(([host, value]) => ({
    host,
    distinctInputDomains: value.domains.size,
    evidencePageCount: value.evidencePages.size,
    occurrences: value.occurrences,
    signals: [...value.signals].sort(),
    sampleUrls: [...value.sampleUrls].sort(),
  })).sort((left, right) =>
    right.distinctInputDomains - left.distinctInputDomains ||
    right.occurrences - left.occurrences ||
    left.host.localeCompare(right.host)
  );
  return {
    schemaVersion: "1.1",
    inputHash,
    probeConfigHash,
    probeConfig: values[0]?.probeConfig || null,
    cohort,
    generatedAt: new Date().toISOString(),
    inputDomains: inputs.length,
    measuredDomains: values.length,
    remainingDomains: inputs.length - values.length,
    detectedCompanies: values.filter((item) => item.provider).length,
    ambiguousCompanies: values.filter((item) => item.detectionStatus === "ambiguous").length,
    completeCanonicalCompanies: values.filter(
      (item) => item.canonicalFetchStatus === "complete"
    ).length,
    verifiedUsCompanies: values.filter(
      (item) => item.verifiedStatus === "verified_us_jobs"
    ).length,
    verifiedUsJobs: values.reduce((sum, item) => sum + item.canonicalUsVerifiedJobs, 0),
    byProvider,
    byClassification,
    probeOutcomes,
    failures,
    unsupportedCareerHostLeads,
  };
}

export function assertCompatibleReceiptCohort(
  receipts: Array<Partial<YieldReceipt>>,
  inputHash: string,
  probeConfigHash: string
) {
  const mismatch = receipts.find(
    (receipt) =>
      receipt.schemaVersion !== "1.1" ||
      receipt.inputHash !== inputHash ||
      receipt.probeConfigHash !== probeConfigHash
  );
  if (mismatch) {
    throw new Error(
      "Receipt file belongs to a different input, probe configuration, or schema; use a new receipts path"
    );
  }
}

async function currentImplementationHash() {
  const sources = [
    ["measure-startup-domain-yield.ts", new URL(import.meta.url)],
    ["ats-adapters.ts", new URL("../lib/ats-adapters.ts", import.meta.url)],
    ["canonical-source-discovery.ts", new URL("../lib/canonical-source-discovery.ts", import.meta.url)],
    ["job-normalization.ts", new URL("../lib/job-normalization.ts", import.meta.url)],
    ["public-web.ts", new URL("../lib/public-web.ts", import.meta.url)],
    ["structured-career-page.ts", new URL("../lib/structured-career-page.ts", import.meta.url)],
  ] as const;
  const hash = createHash("sha256");
  for (const [name, url] of sources) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(url));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  const inputPath = path.resolve(argument("input") || "outputs/startup-domain-pilot.json");
  const receiptsPath = path.resolve(
    argument("receipts") || "outputs/startup-domain-yield.jsonl"
  );
  const summaryPath = path.resolve(
    argument("summary") || "outputs/startup-domain-yield-summary.json"
  );
  const offset = boundedInteger("offset", 0, 0, 499);
  const limit = boundedInteger("limit", 25, 1, 500);
  const concurrency = boundedInteger("concurrency", 4, 1, 4);
  const maxPages = boundedInteger("max-pages", 8, 1, 12);
  const structuredMaxPages = boundedInteger("structured-max-pages", 10, 1, 20);
  const includeStructured = !process.argv.includes("--ats-only");
  const defaultAsOf = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const asOf = argument("as-of") || defaultAsOf;
  if (!Number.isFinite(new Date(asOf).valueOf())) {
    throw new Error("--as-of must be a valid ISO timestamp");
  }
  const artifact = JSON.parse(await readFile(inputPath, "utf8")) as PilotArtifact;
  const inputs = canonicalInputs(artifact);
  if (inputs.length !== 500) {
    throw new Error(`Expected 500 unique permitted pending domains, received ${inputs.length}`);
  }
  const inputHash = createHash("sha256")
    .update(JSON.stringify(inputs))
    .digest("hex");
  const probeConfig: YieldProbeConfig = {
    includeStructured,
    maxPages,
    structuredMaxPages,
    structuredMaxDepth: 1,
    atsAdapterVersion: ATS_ADAPTER_VERSION,
    atsDetectionVersion: ATS_DETECTION_VERSION,
    structuredAdapterVersion: STRUCTURED_CAREER_ADAPTER_VERSION,
    canonicalSourceProbeVersion: CANONICAL_SOURCE_PROBE_VERSION,
    userAgent: CANONICAL_SOURCE_PROBE_USER_AGENT,
    implementationHash: await currentImplementationHash(),
    asOf: new Date(asOf).toISOString(),
  };
  const probeConfigHash = createHash("sha256")
    .update(JSON.stringify(probeConfig))
    .digest("hex");
  const existingText = await readFile(receiptsPath, "utf8").catch(() => "");
  const existing = existingText.split(/\r?\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as YieldReceipt
  );
  assertCompatibleReceiptCohort(existing, inputHash, probeConfigHash);
  const completed = new Set(existing
    .map((receipt) => receipt.domain));
  const attempts = new Map<string, number>();
  for (const receipt of existing) {
    attempts.set(receipt.domain, Math.max(attempts.get(receipt.domain) || 0, receipt.attempt));
  }
  const selected = inputs.slice(offset, Math.min(inputs.length, offset + limit))
    .filter((input) => !completed.has(input.domain));
  await mkdir(path.dirname(receiptsPath), { recursive: true });
  const appended: YieldReceipt[] = [];
  for (let index = 0; index < selected.length; index += concurrency) {
    const batch = selected.slice(index, index + concurrency);
    const results = await Promise.all(batch.map((input) =>
      measure(
        input,
        inputHash,
        probeConfigHash,
        probeConfig,
        artifact.cohort || "unknown",
        (attempts.get(input.domain) || 0) + 1
      )
    ));
    results.sort((left, right) => left.inputIndex - right.inputIndex);
    await appendFile(
      receiptsPath,
      results.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n",
      "utf8"
    );
    appended.push(...results);
    console.log(JSON.stringify({
      completed: existing.length + appended.length,
      batch: results.map((receipt) => ({
        domain: receipt.domain,
        detection: receipt.detectionStatus,
        provider: receipt.provider,
        fetch: receipt.canonicalFetchStatus,
        jobs: receipt.canonicalUsVerifiedJobs,
      })),
    }));
  }
  const allReceipts = [...existing, ...appended];
  const summary = aggregateYield(
    inputs,
    allReceipts,
    inputHash,
    probeConfigHash,
    artifact.cohort || "unknown"
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    input: inputPath,
    receipts: receiptsPath,
    summary: summaryPath,
    selected: selected.length,
    ...summary,
  }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
