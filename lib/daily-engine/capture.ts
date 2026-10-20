import { createHash } from "node:crypto";
import { appendFile, mkdir, opendir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaneId } from "./types";
import { credentialRedactor } from "./credential-redaction";

export type CaptureEvent = {
  url: string; method: string; lane: LaneId;
  phase: "robots" | "redirect" | "search" | "content";
  startedAtUtc: string; elapsedMs: number; requestUnits: number;
  ok: boolean; status?: number; contentType?: string; error?: string;
  body?: { path: string; bytes: number; sha256: string; truncated: boolean; redacted?: boolean };
};
export type CaptureRecorder = {
  paths: { events: string; bodies: string };
  record(event: CaptureEvent, body?: { text: string; truncated: boolean; redacted?: boolean }): Promise<void>;
};
export function createCaptureRecorder(directory: string): CaptureRecorder {
  let sequence = 0;
  let initialized: Promise<void> | undefined;
  const paths = { events: join(directory, "events.jsonl"), bodies: join(directory, "bodies") };
  return { paths, async record(event, body) {
    initialized ??= (async () => {
      await mkdir(paths.bodies, { recursive: true });
      for await (const file of await opendir(paths.bodies)) {
        const match = /^(\d+)-[a-f0-9]{8}\.txt$/.exec(file.name);
        if (match) sequence = Math.max(sequence, Number(match[1]));
      }
    })();
    await initialized;
    const seq = ++sequence;
    if (body) {
      const sha256 = createHash("sha256").update(body.text).digest("hex");
      const path = join(paths.bodies, `${String(seq).padStart(8, "0")}-${sha256.slice(0, 8)}.txt`);
      await writeFile(path, body.text, { flag: "wx" });
      event.body = { path, bytes: Buffer.byteLength(body.text), sha256, truncated: body.truncated, ...(body.redacted ? { redacted: true } : {}) };
    }
    await appendFile(paths.events, JSON.stringify(event) + "\n");
  } };
}

// Only used with capture enabled. Never retain request headers or request bodies.
export async function capturedRequest(
  capture: CaptureRecorder, lane: LaneId, input: RequestInfo | URL, init: RequestInit | undefined,
  perform: () => Promise<Response>, units: () => number, search = false,
): Promise<Response> {
  // Responses and thrown errors can echo credentials. Redact before any disk write.
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const secrets = [headers.get("x-api-key"), headers.get("authorization"), headers.get("x-treg-token")].filter((value): value is string => !!value);
  const redactors = secrets.map(credentialRedactor);
  const clean = (text: string) => {
    for (const redact of redactors) text = redact(text);
    return text.replace(/x-api-key|x-treg-token/gi, "[REDACTED_HEADER]");
  };
  const url = input instanceof Request ? input.url : String(input);
  const start = Date.now();
  const event: CaptureEvent = { url, method: init?.method || (input instanceof Request ? input.method : "GET"), lane,
    phase: search ? "search" : new URL(url).pathname.endsWith("/robots.txt") ? "robots" : "content",
    startedAtUtc: new Date(start).toISOString(), elapsedMs: 0, requestUnits: 0, ok: false };
  let body: { text: string; truncated: boolean; redacted?: boolean } | undefined;
  let response: Response | undefined;
  let failure: unknown;
  try {
    response = await perform();
    event.status = response.status;
    event.contentType = response.headers.get("content-type") || "";
    if (!search && response.status >= 300 && response.status < 400) event.phase = "redirect";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    body = { text: "", truncated: false };
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = 1_000_000 - bytes;
        const part = value.subarray(0, remaining);
        bytes += part.byteLength;
        body.text += decoder.decode(part, { stream: true });
        if (value.byteLength > remaining) {
          body.truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    body.text += decoder.decode();
    if (body.truncated || Number(response.headers.get("content-length")) > 1_000_000) throw new Error("public_document_too_large");
    event.ok = response.ok;
    if (!response.ok) event.error = "http_" + response.status;
  } catch (error) {
    if (body) body.truncated = true;
    failure = error;
    event.error = clean(error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  event.url = clean(event.url);
  if (event.contentType) event.contentType = clean(event.contentType);
  if (event.error) event.error = clean(event.error).slice(0, 500);
  if (body) {
    const text = clean(body.text);
    if (text !== body.text) body.redacted = true;
    body.text = text;
    if (Buffer.byteLength(body.text) > 1_000_000) {
      body.text = Buffer.from(body.text).subarray(0, 999_997).toString("utf8");
      body.truncated = true;
      event.ok = false;
      event.error = "public_document_too_large";
      failure = new Error(event.error);
    }
  }
  event.requestUnits = units();
  event.elapsedMs = Date.now() - start;
  await capture.record(event, body);
  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw clean(message) === message ? failure : new Error(clean(message));
  }
  const rebuilt = new Response([204, 205, 304].includes(response!.status) ? null : body!.text, {
    status: response!.status, headers: event.contentType ? { "content-type": event.contentType } : {},
  });
  // Redirect control metadata stays in memory, never in the reconstructed headers/evidence.
  const location = response!.headers.get("location");
  if (location) redirectLocations.set(rebuilt, location);
  tregResponseMetadata.set(rebuilt, { callId: response!.headers.get("x-treg-call-id"), cost: response!.headers.get("x-treg-cost-micro") });
  return rebuilt;
}
export const redirectLocations = new WeakMap<Response, string>();
export const tregResponseMetadata = new WeakMap<Response, { callId: string | null; cost: string | null }>();
