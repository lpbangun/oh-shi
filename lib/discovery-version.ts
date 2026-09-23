import { ATS_ADAPTER_VERSION, ATS_DETECTION_VERSION } from "./ats-adapters";
import { CANONICAL_SOURCE_PROBE_VERSION } from "./canonical-source-discovery";
import { ATS_SLUG_PROBE_VERSION } from "./ats-slug-probe";
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
 */
export const DISCOVERY_PIPELINE_VERSION = [
  `ats-detection-${ATS_DETECTION_VERSION}`,
  `ats-adapter-${ATS_ADAPTER_VERSION}`,
  `canonical-probe-${CANONICAL_SOURCE_PROBE_VERSION}`,
  `ats-slug-probe-${ATS_SLUG_PROBE_VERSION}`,
  `structured-adapter-${STRUCTURED_CAREER_ADAPTER_VERSION}`,
  `error-classification-${DISCOVERY_CLASSIFICATION_VERSION}`,
].join(":");
