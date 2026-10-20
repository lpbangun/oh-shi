import { REPUTABLE_SOURCES } from "../funding-discovery";

export type ReadinessManifest = {
  schema: "ohshi-live-readiness/1";
  runId: string;
  frozenAtUtc: string;
  authorizedCaps: { maxFetchRequests: number; maxSearchRequests: number; deadlineMsPerLane: number };
  lanes: { direct: { permittedSourceIds: string[] }; tinyfish: { searchQueries: string[] } };
};
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("invalid_readiness_manifest_fields");
}
export function validateReadinessManifest(value: unknown, officialIds: string[] = []): ReadinessManifest {
  object(value, ["schema", "runId", "frozenAtUtc", "authorizedCaps", "lanes"]);
  if (value.schema !== "ohshi-live-readiness/1" || typeof value.runId !== "string" || !/^(?:ohshi-live-readiness-r4-\d{8}(?:T\d{6}Z)?|ohshi-treg-discovery-r1-\d{8})$/.test(value.runId)) throw new Error("invalid_readiness_manifest_identity");
  if (typeof value.frozenAtUtc !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.frozenAtUtc) || !Number.isFinite(Date.parse(value.frozenAtUtc))) throw new Error("invalid_readiness_manifest_timestamp");
  object(value.authorizedCaps, ["maxFetchRequests", "maxSearchRequests", "deadlineMsPerLane"]);
  for (const [key, ceiling] of Object.entries({ maxFetchRequests: 20, maxSearchRequests: 2, deadlineMsPerLane: 600000 })) {
    const n = value.authorizedCaps[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > ceiling) throw new Error("invalid_readiness_manifest_cap_" + key);
  }
  object(value.lanes, ["direct", "tinyfish"]);
  object(value.lanes.direct, ["permittedSourceIds"]);
  object(value.lanes.tinyfish, ["searchQueries"]);
  const ids = value.lanes.direct.permittedSourceIds, queries = value.lanes.tinyfish.searchQueries;
  const allowed = new Set(["wikidata-startups", ...REPUTABLE_SOURCES.map(s => s.id), ...officialIds]);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !allowed.has(id)) || new Set(ids).size !== ids.length) throw new Error("invalid_readiness_manifest_sources");
  if (!Array.isArray(queries) || queries.length > 2 || queries.some(q => typeof q !== "string" || !q.trim() || q.length > 500)) throw new Error("invalid_readiness_manifest_queries");
  return value as ReadinessManifest;
}
