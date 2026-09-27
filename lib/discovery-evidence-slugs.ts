// Only a permitted cohort POC that cites the actual vendor board can authorize
// a slug that differs from the employer's domain label. A generic curated path
// (e.g. curated:listings) or another ATS-family id is not board evidence.
type RegistryEvidence = {
  sourceId: string;
  sourceKind: string;
  sourceClassification: string;
  permissionStatus: string;
  evidenceUrl: string;
};

const BOARD_HOST = [
  /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/,
  /^([a-z0-9-]+)\.recruitee\.com$/,
];

export function registryProbeSlugs(evidence: RegistryEvidence[]) {
  // Preserve candidate generation for Greenhouse's independent board-name check
  // and for domain-label matches. These guesses are NOT vendor authorization.
  const candidates = evidence
    .map((row) => row.sourceId.includes(":") ? row.sourceId.split(":").pop() || "" : "")
    .filter(Boolean);
  return { candidates, corroborating: registryVendorBoardSlugs(evidence) };
}

export function registryVendorBoardSlugs(evidence: RegistryEvidence[]): string[] {
  const slugs = new Set<string>();
  for (const row of evidence) {
    if (row.sourceKind !== "curated_cohort" ||
        row.sourceClassification !== "general_v1_poc" ||
        row.permissionStatus !== "permitted") continue;
    try {
      const url = new URL(row.evidenceUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password) continue;
      const slug = BOARD_HOST.map((host) => host.exec(url.hostname.toLowerCase())?.[1])
        .find(Boolean);
      if (slug && slug !== "www" && slug.length >= 3 && slug.length <= 80 &&
          row.sourceId === `curated:${slug}`) slugs.add(slug);
    } catch {
      // Invalid URLs are not corroboration.
    }
  }
  return [...slugs];
}
