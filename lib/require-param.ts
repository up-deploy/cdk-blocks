/**
 * Read one CDK context value, or fail the synth.
 *
 * Every entrypoint takes its inputs from `-c` context and has to check them itself.
 * The platform's catalog gate validates them too, but this repo is public and can be
 * synthesized with no router in front of it — so the pattern passed here IS the
 * contract, and `catalog/blocks/<name>.yaml` mirrors it. The router's accepted set
 * must stay a subset of the entrypoint's.
 *
 * Context values are always strings, so "absent" and "set to empty" arrive
 * indistinguishable; both are refused. The error names the parameter and prints the
 * pattern because the value travels through `yq`, `GITHUB_OUTPUT` and a workflow
 * input before it gets here, and a bare regex failure would not say which hop
 * mangled it.
 */
export function requireParam(name: string, value: string | undefined, pattern: RegExp): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} not set`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} '${value}' does not match ${pattern.source}`);
  }
  return value;
}
