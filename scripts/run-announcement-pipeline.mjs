import { tsImport } from "tsx/esm/api";
const { announcementCli } = await tsImport("../lib/daily-engine/announcement-cli.ts", import.meta.url);
try { await announcementCli(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
