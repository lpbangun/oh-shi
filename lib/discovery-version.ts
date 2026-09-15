import { ATS_ADAPTER_VERSION, ATS_DETECTION_VERSION } from "./ats-adapters";
import { CANONICAL_SOURCE_PROBE_VERSION } from "./canonical-source-discovery";
import { ATS_SLUG_PROBE_VERSION } from "./ats-slug-probe";
import { STRUCTURED_CAREER_ADAPTER_VERSION } from "./structured-career-page";

/**
 * Stored with every terminal discovery attempt. Bumping any detector or adapter
 * version makes older automatic `needs_review` results eligible for one safe
 * re-check without reopening rejected or actively reviewed candidates.
 */
export const DISCOVERY_PIPELINE_VERSION = [
  `ats-detection-${ATS_DETECTION_VERSION}`,
  `ats-adapter-${ATS_ADAPTER_VERSION}`,
  `canonical-probe-${CANONICAL_SOURCE_PROBE_VERSION}`,
  `ats-slug-probe-${ATS_SLUG_PROBE_VERSION}`,
  `structured-adapter-${STRUCTURED_CAREER_ADAPTER_VERSION}`,
].join(":");
