import { tsImport } from "tsx/esm/api";
const { tregReportCli } = await tsImport("../lib/daily-engine/treg-report.ts", import.meta.url);
try { await tregReportCli(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
