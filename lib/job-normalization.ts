export type CanonicalJobInput = {
  title: string;
  department?: string;
  location?: string;
  isRemote?: boolean | null;
  descriptionPlain?: string;
  address?: { postalAddress?: { addressCountry?: string } };
};

export function isUsEligible(job: CanonicalJobInput) {
  const country = job.address?.postalAddress?.addressCountry || "";
  const location = job.location || "";
  return (
    country === "United States" ||
    job.isRemote === true ||
    /remote|united states|u\.s\.|new york|san francisco|washington|boston|seattle|austin|los angeles/i.test(
      location
    )
  );
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
  const plain = (job.descriptionPlain || "").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 220) : `Canonical posting for ${job.title}.`;
}
