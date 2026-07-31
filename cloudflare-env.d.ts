declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    INGEST_TOKEN?: string;
  }
}

declare const __DEPLOYED_SHA__: string;
