import type { FundingDiscovery } from "./funding-discovery";

/** Persist source-stable announcements and promote only newer funding facts. */
export async function persistFundingDiscoveryRecords(
  database: D1Database,
  discoveries: FundingDiscovery[]
) {
  if (!discoveries.length) {
    return { announcementsAdded: 0, companiesUpdated: 0, affectedCompanyIds: [] as string[] };
  }
  const stored = await database.prepare("SELECT id FROM companies")
    .all<{ id: string }>();
  const companyIds = new Set(stored.results.map((company) => company.id));
  const accepted = discoveries.filter((discovery) => companyIds.has(discovery.companyId));
  const statements: D1PreparedStatement[] = [];
  for (const discovery of accepted) {
    statements.push(
      database.prepare(`INSERT OR IGNORE INTO changes (
        id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
      ) VALUES (?, 'company', ?, 'funding_announced', ?, ?, ?, ?)`).bind(
        discovery.id,
        discovery.companyId,
        discovery.title,
        discovery.description,
        discovery.occurredAt,
        discovery.sourceUrl
      ),
      database.prepare(`UPDATE companies SET
        latest_funding_label=?, latest_funding_date=?,
        stage=COALESCE(?, stage), funding_mode='Venture-backed'
        WHERE id=? AND (latest_funding_date IS NULL OR latest_funding_date < ?)`).bind(
        discovery.latestFundingLabel,
        discovery.occurredAt.slice(0, 10),
        discovery.stage,
        discovery.companyId,
        discovery.occurredAt.slice(0, 10)
      )
    );
  }
  const results = statements.length ? await database.batch(statements) : [];
  return {
    announcementsAdded: results
      .filter((_, index) => index % 2 === 0)
      .reduce((total, result) => total + Number(result.meta.changes || 0), 0),
    companiesUpdated: results
      .filter((_, index) => index % 2 === 1)
      .reduce((total, result) => total + Number(result.meta.changes || 0), 0),
    affectedCompanyIds: [...new Set(accepted.map((discovery) => discovery.companyId))],
  };
}
