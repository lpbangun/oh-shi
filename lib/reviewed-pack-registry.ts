import edtechPack from "../packs/edtech.json";
import otherPack from "../packs/other.json";
import { stableIdentityHash } from "./ingestion-core";
import { normalizeDomain, sourceKey, type AtsProvider } from "./source-registry";

export type ReviewedPackVertical = "edtech" | "other";

export type ReviewedPackRegistryRow = {
  name: string;
  website: string;
  provider: Exclude<AtsProvider, "manual" | "structured">;
  board_id: string;
  evidence_url: string;
  vertical: ReviewedPackVertical;
  employer_kind?: string;
};

type ReviewedPackArtifact = { rows: ReviewedPackRegistryRow[] };

const artifacts = [
  edtechPack as ReviewedPackArtifact,
  otherPack as ReviewedPackArtifact,
];

export const REVIEWED_PACK_ROWS = artifacts.flatMap((artifact) => artifact.rows);

export function reviewedPackCareersUrl(row: ReviewedPackRegistryRow) {
  const board = encodeURIComponent(row.board_id);
  if (row.provider === "ashby") return `https://jobs.ashbyhq.com/${board}`;
  if (row.provider === "greenhouse") return `https://job-boards.greenhouse.io/${board}`;
  if (row.provider === "lever") return `https://jobs.lever.co/${board}`;
  if (row.provider === "workable") return `https://apply.workable.com/${board}`;
  if (row.provider === "recruitee") return `https://${row.board_id}.recruitee.com/`;
  if (row.provider === "personio") return `https://${row.board_id}.jobs.personio.com/`;
  return row.website;
}

export function reviewedPackIdentity(row: ReviewedPackRegistryRow) {
  const domain = normalizeDomain(row.website);
  const hash = stableIdentityHash(`${domain}\u0000${row.provider}\u0000${row.board_id}`);
  const nameSlug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    domain,
    companyId: `company_pack_${hash}`,
    slug: `${nameSlug || "company"}-${hash.slice(0, 8)}`,
    sourceId: sourceKey(row.provider, row.board_id),
  };
}
