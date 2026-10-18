import { tsImport } from "tsx/esm/api";
const { cli } = await tsImport("../lib/daily-engine/cli.ts", import.meta.url);
try { await cli(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
