export const REFRESH_CONTRACT_VERSION = "1.0";

const defaultDelay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function fetchRetryable(url, init, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || defaultDelay;
  const attempts = Math.max(1, options.attempts || 3);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (!isRetryableStatus(response.status) || attempt === attempts) return response;
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
      await sleep(retryAfter ?? attempt * 1_000);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await sleep(attempt * 1_000);
    }
  }
  throw lastError || new Error("Request failed without a response.");
}

function object(value) {
  return value !== null && typeof value === "object" ? value : {};
}

export function validatePreflightContract(payload) {
  const value = object(payload);
  const mutation = object(value.mutation);
  if (
    value.contract_version !== REFRESH_CONTRACT_VERSION ||
    typeof value.deployed_sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value.deployed_sha) ||
    mutation.method !== "POST" ||
    mutation.idempotency_header !== "Idempotency-Key"
  ) {
    throw new Error(
      `Incompatible refresh preflight contract; expected ${REFRESH_CONTRACT_VERSION}.`
    );
  }
  return value;
}

export function validateRefreshContract(payload) {
  const value = object(payload);
  const receipts = object(value.source_receipts);
  const canonical = object(value.canonical);
  const discovery = object(value.discovery);
  const coverage = object(value.coverage);
  const sourceCounts = object(discovery.source_counts);
  const discoveryReceipts = Array.isArray(receipts.discovery) ? receipts.discovery : [];
  const canonicalReceipts = Array.isArray(receipts.canonical) ? receipts.canonical : [];
  const validDiscoveryReceipts = discoveryReceipts.every((raw) => {
    const receipt = object(raw);
    return (
      typeof receipt.source_id === "string" &&
      typeof receipt.access_mode === "string" &&
      ["completed", "manual", "blocked", "failed"].includes(receipt.status) &&
      typeof receipt.fetched === "boolean" &&
      Number.isInteger(receipt.discovered_count) &&
      (receipt.status === "completed"
        ? receipt.fetched
        : receipt.status === "manual" || receipt.status === "blocked"
          ? !receipt.fetched
          : true)
    );
  });
  const validCanonicalReceipts = canonicalReceipts.every((raw) => {
    const receipt = object(raw);
    const quarantined = receipt.status === "quarantined";
    const validQuarantineReason = [
      "mass_deletion_guard",
      "incomplete_payload",
      "parser_error",
    ].includes(receipt.quarantineReason);
    return (
      typeof receipt.sourceId === "string" &&
      typeof receipt.provider === "string" &&
      ["success", "failed", "quarantined"].includes(receipt.status) &&
      Number.isInteger(receipt.observed) &&
      Number.isInteger(receipt.verified) &&
      Number.isInteger(receipt.opened) &&
      Number.isInteger(receipt.closed) &&
      (!quarantined || (
        receipt.verified === 0 &&
        receipt.opened === 0 &&
        receipt.closed === 0 &&
        typeof receipt.snapshotId === "string" &&
        receipt.snapshotId.length > 0 &&
        validQuarantineReason
      ))
    );
  });
  const canonicalSuccesses = canonicalReceipts.filter(
    (raw) => object(raw).status === "success"
  ).length;
  const canonicalFailures = canonicalReceipts.filter(
    (raw) => object(raw).status === "failed"
  ).length;
  const canonicalQuarantines = canonicalReceipts.filter(
    (raw) => object(raw).status === "quarantined"
  ).length;
  const fetchedFailures = discoveryReceipts.filter((raw) => {
    const receipt = object(raw);
    return receipt.status === "failed" && receipt.fetched === true;
  }).length;
  const receiptCountsReconcile =
    Number.isInteger(sourceCounts.configured) &&
    Number.isInteger(sourceCounts.fetched) &&
    Number.isInteger(sourceCounts.manual) &&
    Number.isInteger(sourceCounts.blocked) &&
    Number.isInteger(sourceCounts.failed) &&
    Number.isInteger(sourceCounts.completed) &&
    sourceCounts.reconciled === true &&
    sourceCounts.configured === discoveryReceipts.length &&
    sourceCounts.configured ===
      sourceCounts.completed + sourceCounts.manual +
        sourceCounts.blocked + sourceCounts.failed &&
    sourceCounts.fetched === sourceCounts.completed + fetchedFailures &&
    sourceCounts.manual === discoveryReceipts.filter(
      (raw) => object(raw).status === "manual"
    ).length &&
    sourceCounts.blocked === discoveryReceipts.filter(
      (raw) => object(raw).status === "blocked"
    ).length &&
    sourceCounts.failed === discoveryReceipts.filter(
      (raw) => object(raw).status === "failed"
    ).length &&
    sourceCounts.completed === discoveryReceipts.filter(
      (raw) => object(raw).status === "completed"
    ).length;
  if (
    value.contract_version !== REFRESH_CONTRACT_VERSION ||
    typeof value.deployed_sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value.deployed_sha) ||
    typeof value.run_key !== "string" ||
    typeof canonical.refreshed_at !== "string" ||
    !Number.isInteger(canonical.boards) ||
    !Number.isInteger(canonical.verified) ||
    typeof canonical.overall_status !== "string" ||
    !Number.isInteger(canonical.successful_sources) ||
    !Number.isInteger(canonical.failed_sources) ||
    !Number.isInteger(canonical.quarantined_sources) ||
    !Number.isInteger(canonical.opened) ||
    !Number.isInteger(canonical.closed) ||
    typeof discovery.completed_at !== "string" ||
    typeof discovery.overall_status !== "string" ||
    !Number.isInteger(coverage.activeCompanies) ||
    !Number.isInteger(coverage.verifiedOpenJobs) ||
    !Number.isInteger(coverage.activeHiringSignals) ||
    !Number.isInteger(coverage.offBoardVerifiedOpenings) ||
    !Number.isInteger(coverage.offBoardVerifiedCompanies) ||
    !Number.isInteger(coverage.companiesAddedLast1Day) ||
    !Number.isInteger(coverage.companiesAddedLast7Days) ||
    !Number.isInteger(coverage.jobsAddedLast24Hours) ||
    !Array.isArray(receipts.canonical) ||
    !Array.isArray(receipts.discovery) ||
    canonical.boards !== canonicalReceipts.length ||
    canonical.successful_sources !== canonicalSuccesses ||
    canonical.quarantined_sources !== canonicalQuarantines ||
    canonical.failed_sources !== canonicalFailures + canonicalQuarantines ||
    !validCanonicalReceipts ||
    !validDiscoveryReceipts ||
    !receiptCountsReconcile
  ) {
    throw new Error(
      "Refresh succeeded but returned an incompatible response; the POST will not be repeated."
    );
  }
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function preflightRefresh(url, headers, options = {}) {
  const response = await fetchRetryable(url, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: options.signal,
  }, options);
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(`Refresh preflight returned HTTP ${response.status}: ${String(body).slice(0, 500)}`);
  }
  return validatePreflightContract(body);
}

export async function postRefresh(url, headers, runKey, options = {}) {
  let postCount = 0;
  const response = await fetchRetryable(url, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": runKey },
    cache: "no-store",
    signal: options.signal,
  }, {
    ...options,
    fetchImpl: async (input, init) => {
      postCount += 1;
      return (options.fetchImpl || fetch)(input, init);
    },
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(`Refresh returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return { result: validateRefreshContract(body), postCount };
}

export async function runVersionedRefresh(url, headers, runKey, options = {}) {
  const preflight = await preflightRefresh(url, headers, options);
  const posted = await postRefresh(url, headers, runKey, options);
  if (posted.result.deployed_sha !== preflight.deployed_sha) {
    throw new Error(
      "Refresh completed on a different deployed revision than the preflight; the POST will not be repeated."
    );
  }
  return { preflight, ...posted };
}
