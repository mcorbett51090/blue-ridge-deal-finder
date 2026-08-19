/**
 * Types for the scratch-tree helper. Hand-written because the gate family is
 * plain .mjs (it must run with no build step, before anything is compiled) but
 * tests/gates.test.ts is typechecked like the rest of the pipeline.
 */
export declare function makeScratch(plants?: Record<string, string>): string;
export declare function runGate(
  gateFile: string,
  scratchDir: string,
  args?: string[],
): { code: number | null; out: string };
export declare function dropScratch(dir: string): void;
