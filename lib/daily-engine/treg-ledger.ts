import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type LedgerEntry = { type: "reservation" | "result" | "audit" | "failure"; id: string; at: number; runId: string; tokenScope: string; kind?: "search" | "fetch"; units?: number; [key: string]: unknown };
export type TregLedger = {
  schema: "ohshi-treg-acquisition-ledger/1"; runId: string;
  caps: { maxSearchCalls: number; maxFetchUrlUnits: number; deadlineMs: number };
  counters: { searchCalls: number; fetchUrlUnits: number; elapsedMs: number };
  entries: LedgerEntry[];
};
export function ledgerTotals(entries: LedgerEntry[]) {
  const reservations = entries.filter(e => e.type === "reservation");
  return { searchCalls: reservations.filter(e => e.kind === "search").reduce((n,e) => n + e.units!, 0), fetchUrlUnits: reservations.filter(e => e.kind === "fetch").reduce((n,e) => n + e.units!, 0), elapsedMs: entries.length ? Math.max(...entries.map(e => e.at)) - Math.min(...entries.map(e => e.at)) : 0 };
}
export function validateTregLedger(value: unknown): TregLedger {
  const l = value as TregLedger;
  if (!l || l.schema !== "ohshi-treg-acquisition-ledger/1" || !/^ohshi-treg-discovery-r1-\d{8}$/.test(l.runId) || !Array.isArray(l.entries)) throw new Error("treg_malformed_ledger");
  for (const [key, max] of Object.entries({maxSearchCalls: 2, maxFetchUrlUnits: 20, deadlineMs: 600000})) {
    const n = l.caps?.[key as keyof TregLedger["caps"]];
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("treg_malformed_ledger_caps");
  }
  const ids = new Set<string>(), outcomes = new Set<string>();
  let previousAt = 0;
  for (const e of l.entries) {
    if (!e || !["reservation", "result", "audit", "failure"].includes(e.type) || typeof e.id !== "string" || !Number.isSafeInteger(e.at) || e.at < 0 || e.runId !== l.runId || !/^[a-f0-9]{64}$/.test(e.tokenScope)) throw new Error("treg_malformed_ledger_entry");
    if (e.at < previousAt || outcomes.has(e.id + ":" + e.type)) throw new Error("treg_malformed_ledger_order");
    previousAt = e.at; outcomes.add(e.id + ":" + e.type);
    if (e.type === "reservation") {
      if (ids.has(e.id) || !["search", "fetch"].includes(e.kind!) || !Number.isInteger(e.units) || e.units! < 1 || e.units! > (e.kind === "search" ? 1 : 10)) throw new Error("treg_malformed_ledger_reservation");
      ids.add(e.id);
    } else if (!ids.has(e.id)) throw new Error("treg_malformed_ledger_reference");
  }
  const totals = ledgerTotals(l.entries);
  if (!l.counters || Object.entries(totals).some(([k,v]) => l.counters[k as keyof typeof totals] !== v) || totals.searchCalls > l.caps.maxSearchCalls || totals.fetchUrlUnits > l.caps.maxFetchUrlUnits) throw new Error("treg_malformed_ledger_counters");
  return l;
}
export class PhaseLedger {
  readonly tokenScope: string;
  constructor(readonly path: string, readonly runId: string, key: string) { this.tokenScope = createHash("sha256").update(key).digest("hex"); }
  async read() {
    let ledger: TregLedger;
    try { ledger = validateTregLedger(JSON.parse(await readFile(this.path, "utf8"))); } catch { throw new Error("treg_malformed_ledger"); }
    if (ledger.runId !== this.runId || ledger.entries.some(e => e.tokenScope !== this.tokenScope)) throw new Error("treg_ledger_scope_mismatch");
    return ledger;
  }
  async update(change: (ledger: TregLedger) => void) {
    // A stale lock fails closed after a crash; an operator must inspect it, never reset counters.
    const lock = await open(this.path + ".lock", "wx", 0o600).catch(() => { throw new Error("treg_ledger_locked"); });
    try {
      const ledger = await this.read(); change(ledger);
      ledger.counters = ledgerTotals(ledger.entries);
      validateTregLedger(ledger);
      const temp = this.path + "." + randomUUID() + ".tmp";
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(ledger, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await lock.close(); await unlink(this.path + ".lock"); }
  }
  async reserve(kind: "search" | "fetch", units: number) {
    const id = randomUUID();
    await this.update(l => {
      const totals = ledgerTotals(l.entries), first = l.entries[0]?.at;
      if (totals.searchCalls + (kind === "search" ? units : 0) > l.caps.maxSearchCalls || totals.fetchUrlUnits + (kind === "fetch" ? units : 0) > l.caps.maxFetchUrlUnits || (first !== undefined && Date.now() >= first + l.caps.deadlineMs)) throw new Error("treg_phase_cap_exhausted");
      l.entries.push({type: "reservation", id, at: Date.now(), runId: this.runId, tokenScope: this.tokenScope, kind, units});
    });
    return id;
  }
  async append(id: string, type: "result" | "audit" | "failure", fields: Record<string, unknown>) {
    await this.update(l => { l.entries.push({...fields, type, id, at: Date.now(), runId: this.runId, tokenScope: this.tokenScope}); });
  }
}
