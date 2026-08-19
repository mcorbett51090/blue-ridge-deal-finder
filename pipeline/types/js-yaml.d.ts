/**
 * Minimal typed shim for js-yaml.
 *
 * @types/js-yaml is not in package.json and P1 may not add a dependency, so the
 * surface we actually use is declared here — narrowly. `load` returns `unknown`
 * on purpose: YAML is an untrusted parse boundary and every caller must send the
 * result through zod. A `declare module 'js-yaml'` catch-all would have typed it
 * `any` and silently disabled that requirement.
 */
declare module 'js-yaml' {
  export function load(input: string): unknown;
  export function dump(value: unknown, options?: Record<string, unknown>): string;
  const jsYaml: { load: typeof load; dump: typeof dump };
  export default jsYaml;
}
