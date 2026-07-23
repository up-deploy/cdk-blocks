/**
 * Parsing and validation for the `blockConfig` blob (class-2 config: values that
 * come from the platform's `config/environments/<env>.yaml`, never from the user).
 *
 * Config travels as ONE JSON string rather than one `-c` flag per parameter, because
 * CDK context values are ALWAYS strings: `-c retain=false` yields the string "false",
 * which is truthy in JS. `JSON.parse` restores real booleans.
 *
 * But parsing alone leaves a hole the 2026-07-22 decision already anticipated and which
 * was never closed: an unrecognised key is silently dropped. `{"retian": true}` used to
 * synthesize a bucket with `DeletionPolicy: Delete` and exit 0, while the environment
 * file plainly said the bucket should be retained. In prod that is data loss on the next
 * stack deletion, caused by a transposed letter that nothing reported.
 *
 * So the block validates the blob and rejects unknown keys. The block's own key list is
 * the single definition of what is accepted; it is never mirrored into the catalog.
 */

/**
 * Parse `blockConfig` and reject any key the block does not declare.
 *
 * @param raw     the raw `-c blockConfig=...` context value; absent means "{}"
 * @param allowed the keys this block accepts — keep in sync with the block's config type
 * @param block   block name, used only to make the error message actionable
 */
export function parseBlockConfig<T>(
  raw: string | undefined,
  allowed: readonly string[],
  block: string,
): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw ?? "{}");
  } catch (err) {
    // JSON.parse's own message ("Unexpected token } in JSON at position 17") says
    // nothing about where the value came from, and this one travels through yq,
    // GITHUB_OUTPUT and a workflow input before it gets here.
    throw new Error(
      `blockConfig for '${block}' is not valid JSON: ${(err as Error).message}. ` +
        `Received: ${raw}`,
    );
  }

  // typeof null === "object", and an array is an object too. Both would pass a naive
  // check and then read as an empty config, which is the silent failure again.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new Error(
      `blockConfig for '${block}' must be a JSON object, got ${got}. Received: ${raw}`,
    );
  }

  const unknown = Object.keys(parsed).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown blockConfig key(s) for '${block}': ${unknown.join(", ")}. ` +
        `This block accepts: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}. ` +
        `Fix blocks.${block} in the platform's config/environments/<env>.yaml.`,
    );
  }

  return parsed as T;
}
