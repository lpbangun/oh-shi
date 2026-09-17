export type CanonicalJobInput = {
  title: string;
  department?: string;
  location?: string;
  isRemote?: boolean | null;
  descriptionPlain?: string;
  address?: { postalAddress?: { addressCountry?: string } };
};

export const ROLE_FAMILIES = [
  "People operations",
  "GTM",
  "Operations",
  "Data and research",
  "Engineering",
  "Product",
  "Other",
] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const ROLE_FAMILY_ALIASES: Readonly<Record<string, RoleFamily>> = {
  people: "People operations",
  people_operations: "People operations",
  gtm: "GTM",
  operations: "Operations",
  data: "Data and research",
  data_research: "Data and research",
  data_and_research: "Data and research",
  engineering: "Engineering",
  product: "Product",
  other: "Other",
};

export function normalizeRoleFamily(value: string): RoleFamily | null {
  const trimmed = value.trim();
  const canonical = ROLE_FAMILIES.find(
    (family) => family.toLowerCase() === trimmed.toLowerCase()
  );
  if (canonical) return canonical;
  const slug = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return ROLE_FAMILY_ALIASES[slug] || null;
}

export function isUsEligible(job: CanonicalJobInput) {
  const country = (job.address?.postalAddress?.addressCountry || "").trim();
  const location = (job.location || "").trim();
  const usSignal =
    /\b(?:united states|usa|u\.s\.|us only|remote(?:\s*[-/(]\s*|\s+)us|new york|san francisco|washington(?:,? dc)?|boston|seattle|austin|los angeles|chicago|denver|atlanta|miami|portland|philadelphia|palo alto|mountain view|brooklyn)\b/i;
  if (/^(?:united states|us|usa)$/i.test(country) || usSignal.test(location)) return true;
  if (country && !/^(?:worldwide|global|anywhere)$/i.test(country)) return false;
  if (job.isRemote !== true) return false;
  // A bare/global remote designation is US-eligible. A location naming another
  // country is not treated as US evidence merely because the role is remote.
  return !location ||
    /^(?:remote|remote[- /](?:global|worldwide)|global|worldwide|anywhere)$/i.test(location);
}

export function classifyRole(title: string, department = "") {
  const text = `${title} ${department}`.toLowerCase();
  if (/people|talent|recruit|human resources|\bhr\b|workplace/.test(text)) {
    return "People operations";
  }
  if (/sales|growth|gtm|marketing|capture|revenue/.test(text)) return "GTM";
  if (/operations|chief of staff|strategy/.test(text)) return "Operations";
  if (/research|scient|eval|data|biostat/.test(text)) return "Data and research";
  if (/engineer|developer|technical|software/.test(text)) return "Engineering";
  if (/product|design/.test(text)) return "Product";
  return "Other";
}

export function summarizeCanonicalJob(job: CanonicalJobInput) {
  const description = normalizeCanonicalJobDescription(job);
  return description ? description.slice(0, 220) : `Canonical posting for ${job.title}.`;
}

export function normalizeCanonicalJobDescription(job: CanonicalJobInput) {
  return (job.descriptionPlain || "").replace(/\s+/g, " ").trim();
}
