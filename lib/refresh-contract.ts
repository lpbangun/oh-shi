export const REFRESH_CONTRACT_VERSION = "1.0";

export type DiscoveryReceiptStatus = "completed" | "manual" | "blocked" | "failed";

export type DiscoverySourceReceipt = {
  source_id: string;
  access_mode: string;
  status: DiscoveryReceiptStatus;
  fetched: boolean;
  discovered_count: number;
  error?: string;
};

export type DiscoveryReceiptCounts = {
  configured: number;
  fetched: number;
  manual: number;
  blocked: number;
  failed: number;
  completed: number;
  reconciled: boolean;
};

export function summarizeDiscoveryReceipts(
  receipts: DiscoverySourceReceipt[]
): DiscoveryReceiptCounts {
  const counts = {
    configured: receipts.length,
    fetched: receipts.filter((receipt) => receipt.fetched).length,
    manual: receipts.filter((receipt) => receipt.status === "manual").length,
    blocked: receipts.filter((receipt) => receipt.status === "blocked").length,
    failed: receipts.filter((receipt) => receipt.status === "failed").length,
    completed: receipts.filter((receipt) => receipt.status === "completed").length,
  };
  const fetchedFailures = receipts.filter(
    (receipt) => receipt.status === "failed" && receipt.fetched
  ).length;
  return {
    ...counts,
    reconciled:
      counts.configured ===
        counts.completed + counts.manual + counts.blocked + counts.failed &&
      counts.fetched === counts.completed + fetchedFailures &&
      receipts.every((receipt) =>
        receipt.status === "completed"
          ? receipt.fetched
          : receipt.status === "manual" || receipt.status === "blocked"
            ? !receipt.fetched
            : true
      ),
  };
}

export function deployedSha() {
  if (
    typeof __DEPLOYED_SHA__ !== "string" ||
    !/^[0-9a-f]{40}$/i.test(__DEPLOYED_SHA__)
  ) {
    throw new Error("A full deployed Git SHA is unavailable.");
  }
  return __DEPLOYED_SHA__;
}

export function refreshPreflight(revision = deployedSha()) {
  return {
    contract_version: REFRESH_CONTRACT_VERSION,
    deployed_sha: revision,
    mutation: {
      method: "POST",
      idempotency_header: "Idempotency-Key",
    },
    response_fields: [
      "contract_version",
      "deployed_sha",
      "run_key",
      "canonical",
      "discovery",
      "coverage",
      "source_receipts",
    ],
  };
}

export function refreshEnvelope<TCanonical, TDiscovery, TCoverage>(input: {
  runKey: string;
  canonical: TCanonical & { sources?: unknown[] };
  discovery: TDiscovery & { receipts?: DiscoverySourceReceipt[] };
  coverage: TCoverage;
  revision?: string;
}) {
  return {
    contract_version: REFRESH_CONTRACT_VERSION,
    deployed_sha: input.revision || deployedSha(),
    run_key: input.runKey,
    canonical: input.canonical,
    discovery: input.discovery,
    coverage: input.coverage,
    source_receipts: {
      canonical: input.canonical.sources || [],
      discovery: input.discovery.receipts || [],
    },
  };
}
