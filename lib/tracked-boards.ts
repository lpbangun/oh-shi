export const TRACKED_BOARDS = [
  { companyId: "company_ataraxis", slug: "ataraxis-ai", board: "ataraxis-ai" },
  { companyId: "company_cognition", slug: "cognition", board: "cognition" },
  { companyId: "company_conduct", slug: "conduct", board: "conduct" },
  { companyId: "company_edison", slug: "edison-scientific", board: "Edison Scientific" },
  { companyId: "company_hotplate", slug: "hotplate", board: "hotplate" },
  { companyId: "company_ramp", slug: "ramp", board: "ramp" },
  { companyId: "company_watershed", slug: "watershed", board: "watershed" },
  { companyId: "company_vanta", slug: "vanta", board: "vanta" },
  { companyId: "company_harvey", slug: "harvey", board: "harvey" },
  { companyId: "company_abridge", slug: "abridge", board: "abridge" },
  { companyId: "company_higharc", slug: "higharc", board: "higharc" },
  { companyId: "company_suno", slug: "suno", board: "suno" },
] as const;

export function isBoardTracked(companyId: string) {
  return TRACKED_BOARDS.some((source) => source.companyId === companyId);
}
