import assert from "node:assert/strict";
import test from "node:test";
import {
  REFRESH_CONTRACT_VERSION,
  postRefresh,
  preflightRefresh,
  runVersionedRefresh,
} from "../lib/refresh-client.mjs";
import {
  refreshEnvelope,
  refreshPreflight,
  summarizeDiscoveryReceipts,
  type DiscoverySourceReceipt,
} from "../lib/refresh-contract";
import {
  executeRefreshOnce,
  type StoredRefreshResponse,
} from "../lib/refresh-idempotency";

const REVISION_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function validRefreshResponse(runKey: string, revision = REVISION_A) {
  return refreshEnvelope({
    runKey,
    canonical: {
      refreshed_at: "2026-07-30T20:00:00.000Z",
      boards: 1,
      successful_sources: 1,
      failed_sources: 0,
      quarantined_sources: 0,
      verified: 700,
      opened: 0,
      closed: 0,
      overall_status: "success",
      sources: [{
        sourceId: "ashby:acme",
        companyId: "company_acme",
        provider: "ashby",
        status: "success",
        observed: 700,
        verified: 700,
        opened: 0,
        closed: 0,
      }],
    },
    discovery: {
      completed_at: "2026-07-30T20:00:00.000Z",
      overall_status: "success",
      source_counts: {
        configured: 0, fetched: 0, manual: 0, blocked: 0,
        failed: 0, completed: 0, reconciled: true,
      },
      receipts: [],
    },
    coverage: {
      activeCompanies: 12,
      verifiedOpenJobs: 700,
      activeHiringSignals: 0,
      offBoardVerifiedOpenings: 0,
      offBoardVerifiedCompanies: 0,
      companiesAddedLast1Day: 0,
      companiesAddedLast7Days: 0,
      jobsAddedLast24Hours: 0,
    },
    revision,
  });
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function fakeFetch(handlers: Array<(input: unknown, init?: RequestInit) => Response | Promise<Response>>) {
  let index = 0;
  const calls: Array<{ method: string }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ method: init?.method || "GET" });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(input, init);
  }) as typeof fetch;
  return { impl, calls };
}

test("preflight is a read-only GET and reports contract compatibility", async () => {
  const { impl, calls } = fakeFetch([
    () => jsonResponse(200, refreshPreflight(REVISION_A)),
  ]);
  const result = await preflightRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    { fetchImpl: impl, sleep: async () => {} }
  );
  assert.equal(result.contract_version, REFRESH_CONTRACT_VERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("an incompatible schema version blocks the POST entirely", async () => {
  const { impl, calls } = fakeFetch([
    () => jsonResponse(200, {
      ...refreshPreflight(REVISION_A),
      contract_version: "2.0",
    }),
  ]);
  await assert.rejects(
    runVersionedRefresh(
      "https://example.com/api/internal/refresh",
      { authorization: "Bearer secret" },
      "scheduled-run-1",
      { fetchImpl: impl, sleep: async () => {} }
    ),
    /Incompatible refresh preflight contract/
  );
  const postCalls = calls.filter((call) => call.method === "POST");
  assert.equal(postCalls.length, 0);
});

test("a successful but incompatible POST response is not repeated", async () => {
  const { impl, calls } = fakeFetch([
    () => jsonResponse(200, refreshPreflight(REVISION_A)),
    () => jsonResponse(200, { overall_status: "success" }),
  ]);
  await assert.rejects(
    runVersionedRefresh(
      "https://example.com/api/internal/refresh",
      { authorization: "Bearer secret" },
      "scheduled-run-2",
      { fetchImpl: impl, sleep: async () => {} }
    ),
    /POST will not be repeated/
  );
  const postCalls = calls.filter((call) => call.method === "POST");
  assert.equal(postCalls.length, 1);
});

test("a mixed refresh accepts quarantined source receipts without repeating the POST", async () => {
  const response = validRefreshResponse("scheduled-run-quarantine");
  response.canonical.boards = 2;
  response.canonical.failed_sources = 1;
  response.canonical.quarantined_sources = 1;
  response.canonical.overall_status = "partial_success";
  response.canonical.sources.push({
    sourceId: "ashby:truncated",
    companyId: "company_truncated",
    provider: "ashby",
    status: "quarantined",
    snapshotId: "canonical_run:ashby:truncated",
    observed: 1,
    verified: 0,
    opened: 0,
    closed: 0,
    error: "mass_deletion_guard: observed 1 of 100 previously open jobs",
    quarantineReason: "mass_deletion_guard",
  });
  const { impl, calls } = fakeFetch([
    () => jsonResponse(200, refreshPreflight(REVISION_A)),
    () => jsonResponse(200, response),
  ]);
  const result = await runVersionedRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-quarantine",
    { fetchImpl: impl, sleep: async () => {} }
  );
  assert.equal(result.postCount, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("parser and incomplete-payload quarantine receipts satisfy the response contract", async () => {
  for (const quarantineReason of ["parser_error", "incomplete_payload"]) {
    const runKey = `scheduled-run-${quarantineReason}`;
    const response = validRefreshResponse(runKey);
    response.canonical.boards = 2;
    response.canonical.failed_sources = 1;
    response.canonical.quarantined_sources = 1;
    response.canonical.overall_status = "partial_success";
    response.canonical.sources.push({
      sourceId: `ashby:${quarantineReason}`,
      companyId: `company_${quarantineReason}`,
      provider: "ashby",
      status: "quarantined",
      snapshotId: `canonical_run:ashby:${quarantineReason}`,
      observed: 0,
      verified: 0,
      opened: 0,
      closed: 0,
      error: quarantineReason,
      quarantineReason,
    });
    const { impl, calls } = fakeFetch([
      () => jsonResponse(200, refreshPreflight(REVISION_A)),
      () => jsonResponse(200, response),
    ]);
    const result = await runVersionedRefresh(
      "https://example.com/api/internal/refresh",
      { authorization: "Bearer secret" },
      runKey,
      { fetchImpl: impl, sleep: async () => {} }
    );
    assert.equal(result.postCount, 1);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  }
});

test("network errors are retried at most three times", async () => {
  const response = validRefreshResponse("scheduled-run-3");
  let postAttempts = 0;
  const { impl } = fakeFetch([
    () => jsonResponse(200, refreshPreflight(REVISION_A)),
    () => {
      postAttempts += 1;
      if (postAttempts < 3) throw new TypeError("network error");
      return jsonResponse(200, response);
    },
  ]);
  const result = await runVersionedRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-3",
    { fetchImpl: impl, sleep: async () => {} }
  );
  assert.equal(result.postCount, 3);
  assert.equal(postAttempts, 3);
});

test("a deployment change between preflight and POST is reported without another POST", async () => {
  const { impl, calls } = fakeFetch([
    () => jsonResponse(200, refreshPreflight(REVISION_A)),
    () => jsonResponse(200, validRefreshResponse("scheduled-run-sha", REVISION_B)),
  ]);
  await assert.rejects(runVersionedRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-sha",
    { fetchImpl: impl, sleep: async () => {} }
  ), /different deployed revision/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("429 responses are retried at most three times and honor Retry-After", async () => {
  const delays: number[] = [];
  let postAttempts = 0;
  const { impl } = fakeFetch([
    () => {
      postAttempts += 1;
      return jsonResponse(429, { error: "rate limited" }, { "retry-after": "2" });
    },
  ]);
  await assert.rejects(postRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-4",
    {
      fetchImpl: impl,
      attempts: 3,
      sleep: async (ms: number) => { delays.push(ms); },
    }
  ), /HTTP 429/);
  assert.ok(postAttempts <= 3, `expected at most 3 POST attempts, got ${postAttempts}`);
  assert.deepEqual(delays, [2000, 2000], "Retry-After seconds must be honored between retries");
});

test("5xx responses are retried at most three times", async () => {
  let postAttempts = 0;
  const { impl } = fakeFetch([
    () => {
      postAttempts += 1;
      return jsonResponse(503, { error: "unavailable" });
    },
  ]);
  await assert.rejects(postRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-5",
    { fetchImpl: impl, attempts: 3, sleep: async () => {} }
  ), /HTTP 503/);
  assert.equal(postAttempts, 3);
});

test("non-retryable HTTP failures issue exactly one POST", async () => {
  let postAttempts = 0;
  const { impl } = fakeFetch([
    () => {
      postAttempts += 1;
      return jsonResponse(400, { error: "bad request" });
    },
  ]);
  await assert.rejects(postRefresh(
    "https://example.com/api/internal/refresh",
    { authorization: "Bearer secret" },
    "scheduled-run-6",
    { fetchImpl: impl, attempts: 3, sleep: async () => {} }
  ), /HTTP 400/);
  assert.equal(postAttempts, 1);
});

test("a duplicate run key cannot execute the mutation twice", async () => {
  const records = new Map<string, StoredRefreshResponse<{ ok: boolean }>>();
  const claimed = new Set<string>();
  const store = {
    async claim(runKey: string) {
      if (claimed.has(runKey)) return false;
      claimed.add(runKey);
      return true;
    },
    async read(runKey: string) {
      return records.get(runKey) || null;
    },
    async complete(runKey: string, response: StoredRefreshResponse<{ ok: boolean }>) {
      records.set(runKey, response);
    },
  };
  let mutations = 0;
  const work = async () => {
    mutations += 1;
    return { completed: true, httpStatus: 200, body: { ok: true } };
  };
  const first = await executeRefreshOnce("duplicate-run-key", store, work);
  const second = await executeRefreshOnce("duplicate-run-key", store, work);
  assert.equal(first.kind, "executed");
  assert.equal(second.kind, "replayed");
  assert.equal(mutations, 1);
});

test("a crash after an uncertain mutation quarantines the run key instead of retrying it", async () => {
  const claimed = new Set<string>();
  const store = {
    async claim(runKey: string) {
      if (claimed.has(runKey)) return false;
      claimed.add(runKey);
      return true;
    },
    async read() {
      return null;
    },
    async complete() {
      throw new Error("completion should not run after the simulated crash");
    },
  };
  let mutations = 0;
  const work = async () => {
    mutations += 1;
    throw new Error("connection lost after mutation");
  };
  await assert.rejects(
    executeRefreshOnce("crashed-run-key", store, work),
    /connection lost/
  );
  const retry = await executeRefreshOnce("crashed-run-key", store, work);
  assert.equal(retry.kind, "duplicate_in_progress");
  assert.equal(mutations, 1);
});

test("source receipts dynamically distinguish two fetched sources from eight accounted blocked sources", () => {
  const receipts: DiscoverySourceReceipt[] = [
    { source_id: "general-catalyst", access_mode: "public_page", status: "completed", fetched: true, discovered_count: 4 },
    { source_id: "sequoia", access_mode: "public_page", status: "completed", fetched: true, discovered_count: 3 },
    ...Array.from({ length: 8 }, (_, index) => ({
      source_id: `blocked-${index}`,
      access_mode: "awaiting_permission",
      status: "blocked" as const,
      fetched: false,
      discovered_count: 0,
    })),
  ];
  assert.deepEqual(summarizeDiscoveryReceipts(receipts), {
    configured: 10,
    fetched: 2,
    manual: 0,
    blocked: 8,
    failed: 0,
    completed: 2,
    reconciled: true,
  });
});

test("successful source receipts are preserved after a later source fails", () => {
  const receipts: DiscoverySourceReceipt[] = [
    { source_id: "general-catalyst", access_mode: "public_page", status: "completed", fetched: true, discovered_count: 5 },
    { source_id: "sequoia", access_mode: "public_page", status: "failed", fetched: true, discovered_count: 0, error: "timeout" },
    { source_id: "manual-import", access_mode: "manual_import", status: "failed", fetched: false, discovered_count: 0, error: "receipt persistence failed" },
  ];
  assert.equal(receipts[0].status, "completed");
  assert.deepEqual(summarizeDiscoveryReceipts(receipts), {
    configured: 3,
    fetched: 2,
    manual: 0,
    blocked: 0,
    failed: 2,
    completed: 1,
    reconciled: true,
  });
});
