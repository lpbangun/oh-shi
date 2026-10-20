import { Miniflare } from "miniflare";
import { initializeStore } from "./persist";
export async function openLocalStore(path?: string, databaseId = "daily-engine") {
  const miniflare = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response('local daily store') } }",
    compatibilityDate: "2026-05-22", d1Databases: { DB: databaseId },
    ...(path ? { d1Persist: path } : {}),
  });
  try {
    const db = await miniflare.getD1Database("DB") as unknown as D1Database;
    await initializeStore(db);
    return { db, close: () => miniflare.dispose() };
  } catch (error) { await miniflare.dispose(); throw error; }
}
