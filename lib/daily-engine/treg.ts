import { constants } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { boundedText } from "../public-web";
import { capturedRequest, tregResponseMetadata, type CaptureRecorder } from "./capture";
import { PhaseLedger } from "./treg-ledger";
import { credentialRedactor } from "./credential-redaction";
import type { CapCounter } from "./types";

export const TREG_KEY_FILE = "/home/logani/.hermes/profiles/jobman/credentials/bobyard-treg.key";
export const TREG_SEARCH = "tinyfish.web.search";
export const TREG_FETCH = "tinyfish.web.fetch";
export async function loadTregKey(path: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new Error("treg_key_missing_or_unreadable"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) throw new Error("treg_key_requires_regular_file_mode_0600");
    const key = (await file.readFile("utf8")).trim();
    if (!key) throw new Error("treg_key_empty");
    return key;
  } finally { await file.close(); }
}
export function redactTreg(text: string, key: string) {
  return credentialRedactor(key)(text).replace(/x-treg-token/gi, "[REDACTED_HEADER]");
}
export function assertTregRoute(url: string) {
  const u = new URL(url);
  if (u.origin !== "https://treg.to" || u.username || u.password || u.hash || !(/^\/call\/tinyfish\.web\.(search|fetch)$/.test(u.pathname) || /^\/catalog\/endpoints\/tinyfish\.web\.(search|fetch)\/access$/.test(u.pathname) || /^\/calls\/[a-zA-Z0-9_-]+$/.test(u.pathname))) throw new Error("treg_route_refused");
}
export type TregOptions = { keyFile: string; ledger?: string; runId?: string; audits?: string; /* Offline unit-test injection; CLI never supplies this. */ keyLoader?: typeof loadTregKey };
export class TregTransport {
  private stopped = false;
  private ready = false;
  private ledger: PhaseLedger;
  constructor(private key: string, options: TregOptions, private fetcher: typeof fetch = fetch) {
    if (!options.ledger) throw new Error("treg_ledger_required");
    if (!options.runId) throw new Error("treg_run_identity_required");
    this.redact = credentialRedactor(key);
    this.ledger = new PhaseLedger(options.ledger, options.runId, key);
    this.audits = options.audits;
  }
  private audits?: string;
  private readonly redact: (text: string) => string;
  clean(text: string) { return this.redact(text).replace(/x-treg-token/gi, "[REDACTED_HEADER]"); }
  private async request(url: string, init: RequestInit = {}) {
    assertTregRoute(url);
    const headers = new Headers(init.headers); headers.set("X-Treg-Token", this.key);
    return this.fetcher(url, {...init, headers, redirect: "error", signal: AbortSignal.timeout(60000)});
  }
  private async metadata(url: string) {
    const response = await this.request(url);
    const body = this.clean(await boundedText(response, 1_000_000));
    if (!response.ok || !/json/i.test(response.headers.get("content-type") || "")) throw new Error("treg_metadata_invalid status=" + response.status);
    try { return JSON.parse(body); } catch { throw new Error("treg_metadata_malformed"); }
  }
  async preflight() {
    await this.ledger.read();
    for (const endpoint of [TREG_SEARCH, TREG_FETCH]) {
      const p = await this.metadata("https://treg.to/catalog/endpoints/" + endpoint + "/access");
      // Access responses prove platform tier and explicit numeric zero; catalog fields are not required.
      if (p?.tier !== "platform" || p.estimated_cost_micro !== 0) throw new Error("treg_access_not_proven_free " + endpoint);
    }
    this.ready = true;
  }
  async call(url: string, urls: string[] | undefined, caps: CapCounter, capture?: CaptureRecorder) {
    if (!capture) throw new Error("treg_capture_required");
    if (this.stopped) throw new Error("treg_transport_stopped");
    assertTregRoute(url);
    const endpoint = urls ? TREG_FETCH : TREG_SEARCH;
    if (new URL(url).pathname !== "/call/" + endpoint || (urls && (urls.length < 1 || urls.length > 10))) throw new Error("treg_route_refused");
    const units = urls?.length ?? 1, kind = urls ? "fetch" : "search";
    if (Date.now() >= caps.deadlineAt || (urls ? caps.fetchRequests + units > caps.maxFetchRequests : caps.searchRequests + units > caps.maxSearchRequests)) throw new Error("treg_phase_cap_exhausted");
    const id = await this.ledger.reserve(kind, units);
    const init: RequestInit = {method: urls ? "POST" : "GET", redirect: "error", headers: {"X-Treg-Token": this.key, "X-Treg-Route-Max-Cost": "0", "Idempotency-Key": randomUUID(), ...(urls ? {"Content-Type": "application/json"} : {})}, ...(urls ? {body: JSON.stringify({urls, format: "html", ttl: 0, per_url_timeout_ms: 30000})} : {})};
    let status: number | null = null, cost: string | null = null, callId: string | null = null, auditOutcome = "not_read", failure: string | undefined;
    let response: Response | undefined;
    let audit: Record<string, unknown> | undefined;
    let attempted = false;
    try {
      if (!this.ready) await this.preflight();
      const current = await this.ledger.read();
      if (Date.now() >= caps.deadlineAt || Date.now() >= current.entries[0].at + current.caps.deadlineMs) throw new Error("treg_phase_cap_exhausted");
      let captureFailure: unknown;
      try { response = await capturedRequest(capture, "tinyfish", url, init, async () => {
        attempted = true;
        if (urls) caps.fetchRequests += units; else caps.searchRequests += units;
        const r = await this.request(url, init);
        status = r.status; cost = r.headers.get("x-treg-cost-micro"); callId = r.headers.get("x-treg-call-id");
        return r;
      }, () => units, !urls); } catch (error) { captureFailure = error; }
      const meta = response ? tregResponseMetadata.get(response) : undefined;
      cost = meta?.cost ?? cost; callId = meta?.callId ?? callId;
      // Read back every identified call, even if its cost header is unsafe. No more /call after any failure.
      if (!callId || callId.includes(this.key) || !/^[a-zA-Z0-9_-]+$/.test(callId)) throw new Error("treg_audit_missing_call_id");
      const payload = await this.metadata("https://treg.to/calls/" + callId);
      const c = payload?.call || {};
      const upstream = urls ? "https://api.fetch.tinyfish.ai/" : "https://api.search.tinyfish.ai/";
      const ledger = payload?.ledger;
      const ledgerValid = Array.isArray(ledger) && ledger.length > 0 && ledger.every(e => e && (e.kind === "reserve" || e.kind === "settle") && e.amount_micro === 0 && e.endpoint_id === endpoint) && ledger.some(e => e.kind === "reserve") && ledger.some(e => e.kind === "settle");
      const auditMismatch = c.endpoint_id !== endpoint || c.tool_name !== endpoint || c.provider !== "tinyfish" || c.cost_charged_micro !== 0 || c.refused_by != null ? "call_identity_or_cost" :
        c.path !== upstream ? "upstream_path" : c.credential_tier !== "platform" ? "credential_tier" : payload?.charged_micro !== 0 ? "charged_micro" : !ledgerValid ? "ledger_proof" : undefined;
      auditOutcome = auditMismatch ? "mismatch" : "verified_zero";
      const safe = (value: unknown) => this.clean(String(value ?? "UNKNOWN")).slice(0, 200);
      // Allowlist only; never persist user_email, api_key, or arbitrary nested provider echoes.
      audit = {id: typeof c.id === "number" ? c.id : safe(c.id ?? callId), call_ref: callId, endpoint_id: safe(c.endpoint_id), tool_name: safe(c.tool_name), provider: safe(c.provider), path: safe(c.path), credential_tier: safe(c.credential_tier), cost_charged_micro: typeof c.cost_charged_micro === "number" ? c.cost_charged_micro : null, refused_by: c.refused_by == null ? null : safe(c.refused_by), ...(typeof c.created_at === "string" ? {created_at: this.clean(c.created_at)} : {}), ...(typeof c.ledger_id === "string" ? {ledger_id: this.clean(c.ledger_id)} : {})};
      const auditLedger = Array.isArray(ledger) ? ledger.slice(0, 20).map((e: Record<string, unknown> | null) => ({kind: this.clean(String(e?.kind)).slice(0,100), amount_micro: typeof e?.amount_micro === "number" ? e.amount_micro : null, endpoint_id: this.clean(String(e?.endpoint_id)).slice(0,100), created_at: this.clean(String(e?.created_at)).slice(0,100)})) : [];
      const charged_micro = typeof payload?.charged_micro === "number" ? payload.charged_micro : null;
      await this.ledger.append(id, "audit", {callId, audit, ledger: auditLedger, charged_micro});
      if (this.audits) { await mkdir(this.audits, {recursive: true}); await writeFile(join(this.audits, callId + ".json"), this.clean(JSON.stringify({call: audit, ledger: auditLedger, charged_micro}, null, 2)) + "\n", {flag: "wx"}); }
      if (auditOutcome !== "verified_zero") throw new Error("treg_audit_mismatch " + auditMismatch);
      if (cost !== "0") throw new Error("treg_cost_guard header=" + this.clean(String(cost)).slice(0, 100));
      if (status! >= 300 && status! < 400) throw new Error("treg_redirect_refused status=" + status);
      if (captureFailure) throw captureFailure;
      return response!;
    } catch (error) {
      this.stopped = true;
      failure = this.clean(error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.ledger.append(id, "failure", {error: failure});
      throw new Error(failure);
    } finally {
      await this.ledger.append(id, "result", {status, costHeader: cost === null ? null : this.clean(cost).slice(0,100), callId: callId ? this.clean(callId).slice(0,200) : null, auditOutcome, unitsConsumed: attempted ? units : 0, ...(failure ? {error: failure} : {})});
    }
  }
}
