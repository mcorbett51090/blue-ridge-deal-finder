/**
 * CLI entry point for P7 enrichment.
 *
 *   npm run enrich -- --limit 25 --counties Watauga,Mitchell,Yancey [--slope]
 *
 * Separate from index.ts so that importing the orchestrator (from a test, or
 * from a future scoring step) runs nothing. Nothing in pipeline/enrich/ opens a
 * socket at import time, and this file is the only place that starts a run.
 */
import { main } from './index.ts';

await main(process.argv.slice(2));
