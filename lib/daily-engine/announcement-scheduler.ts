import { discoveryAttemptDue } from "../discovery-policy";
import { boundedDiscoveryScheduleLimit, DISCOVERY_SCHEDULE_MAX_ITEMS } from "../discovery-scheduler";

export type AnnouncementTickOptions = {
  now: string;
  enabled?: boolean;
  dryRun?: boolean;
  network?: boolean;
  persistLocal?: boolean;
  maxAnnouncements?: number;
  nextAttemptAt?: string;
  resolving?: boolean;
  lastAttemptedAt?: string;
};

/** One caller-owned local tick, not a daemon or a durable multi-process lease.
 * Uses discovery's finite page and due/stale-claim boundaries. No fetcher or DB.
 * Returned nextAttemptAt must be supplied by the caller on a subsequent tick.
 */
export async function runAnnouncementScheduleTick(options: AnnouncementTickOptions, run: (limit: number) => Promise<void>) {
  if (options.network || options.dryRun === false || options.persistLocal) throw new Error("announcement_schedule_offline_dry_run_only");
  for (const time of [options.now, options.nextAttemptAt, options.lastAttemptedAt]) {
    if (time !== undefined && !Number.isFinite(Date.parse(time))) throw new Error("invalid_schedule_time");
  }
  const requested = options.maxAnnouncements ?? DISCOVERY_SCHEDULE_MAX_ITEMS;
  if (!Number.isInteger(requested) || requested < 0 || !Number.isFinite(requested)) throw new Error("invalid_schedule_limit");
  const limit = boundedDiscoveryScheduleLimit(requested);
  const receipt = { now: options.now, enabled: options.enabled === true, dryRun: true, network: false, publicFetches: 0, maxAnnouncements: limit, ran: false, nextAttemptAt: options.nextAttemptAt ?? null };
  if (!options.enabled) return { ...receipt, status: "disabled" };
  if (!limit) return { ...receipt, status: "limit_zero" };
  if (!discoveryAttemptDue(options.now, options.nextAttemptAt, options.resolving, options.lastAttemptedAt)) return { ...receipt, status: "not_due" };
  // Synchronous decision before the single awaited callback; no background work.
  await run(limit);
  return { ...receipt, status: "ran", ran: true, lastAttemptedAt: options.now,
    nextAttemptAt: new Date(Date.parse(options.now) + 24 * 60 * 60 * 1_000).toISOString() };
}
