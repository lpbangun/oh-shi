import { ATS_ADAPTER_VERSION, ATS_DETECTION_VERSION } from "./ats-adapters";
import { CANONICAL_SOURCE_PROBE_VERSION } from "./canonical-source-discovery";
import { ATS_SLUG_CORROBORATION_VERSION, ATS_SLUG_PROBE_VERSION } from "./ats-slug-probe";
import { STRUCTURED_CAREER_ADAPTER_VERSION } from "./structured-career-page";
import { DISCOVERY_CLASSIFICATION_VERSION } from "./discovery-policy";

/**
 * Stored with every terminal discovery attempt. Bumping any component —
 * detector, adapter, or the error-classification behavior — makes older
 * automatic `needs_review` results eligible for one safe re-check without
 * reopening rejected or actively reviewed candidates.
 *
 * `error-classification-2` (2026-09-23): the Workers subrequest ceiling is now
 * deferrable instead of terminal. That is a real pipeline behavior change, so
 * the version moves with it: candidates previously burned by the platform
 * limit are re-queued through this re-check, never by direct D1 writes.
 *
 * `slug-corroboration-1` (2026-09-23): a slug the candidate's own registry
 * evidence recorded may now corroborate a personio/recruitee board whose host
 * the registrable domain label does not name (user-approved remediation (d)).
 * That is a real slug-corroboration behavior change, so it gets its own named
 * component — no detector or adapter version moves for behavior it did not
 * change — and the candidates the old guard refused re-queue through this
 * re-check, never by direct D1 writes.
 *
 * `slug-corroboration-2` narrows that exception to permitted general-v1 POC
 * evidence whose HTTPS URL is the exact Personio/Recruitee board host for the
 * recorded slug. A generic curated page suffix is not board corroboration.
 */
export const DISCOVERY_PIPELINE_VERSION = [
  `ats-detection-${ATS_DETECTION_VERSION}`,
  `ats-adapter-${ATS_ADAPTER_VERSION}`,
  `canonical-probe-${CANONICAL_SOURCE_PROBE_VERSION}`,
  `ats-slug-probe-${ATS_SLUG_PROBE_VERSION}`,
  `structured-adapter-${STRUCTURED_CAREER_ADAPTER_VERSION}`,
  `error-classification-${DISCOVERY_CLASSIFICATION_VERSION}`,
  `slug-corroboration-${ATS_SLUG_CORROBORATION_VERSION}`,
].join(":");
