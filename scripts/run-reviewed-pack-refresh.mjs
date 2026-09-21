import {
  REFRESH_CONTRACT_VERSION,
  runVersionedRefresh,
} from "../lib/refresh-client.mjs";

const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();

if (!baseUrlValue || !ingestToken) {
  throw new Error("OH_SHI_BASE_URL and OH_SHI_INGEST_TOKEN are required.");
}

const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
  throw new Error("OH_SHI_BASE_URL must be a plain HTTPS deployment origin.");
}

const runKey = process.env.GITHUB_RUN_ID
  ? `reviewed-pack-${process.env.GITHUB_RUN_ID}`
  : `reviewed-pack-${Date.now()}-${crypto.randomUUID()}`;
const url = new URL("/api/internal/refresh?phase=canonical&cadence=daily", baseUrl);
const result = await runVersionedRefresh(
  url,
  {
    Authorization: `Bearer ${ingestToken}`,
    "User-Agent": `OH-SHI-Reviewed-Pack/${REFRESH_CONTRACT_VERSION}`,
  },
  runKey,
  {
    attempts: 3,
    fetchImpl: (input, init) => fetch(input, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(600_000),
    }),
    conflictPollAttempts: 60,
    conflictPollDelayMs: 15_000,
    conflictPollMaxDelayMs: 30_000,
  }
);

const canonical = result.result.canonical;
console.log(
  `Reviewed-pack refresh ${result.result.run_key}: ` +
  `${canonical.successful_sources}/${canonical.boards} boards, ` +
  `${canonical.verified} verified, ${canonical.opened} opened, ${canonical.closed} closed.`
);
