import { z } from "zod";

/**
 * Turn the raw `-c blockConfig=...` string into a validated config object.
 *
 * Config travels as ONE JSON string, not one `-c` flag per parameter, because CDK
 * context values are ALWAYS strings: `-c retain=false` yields the string "false", which
 * is truthy in JS. Parsing restores real booleans, and the schema now also REJECTS
 * `retain: "false"` — a wrong type, not just an unknown key.
 *
 * The schema owns shape (which keys, which types, no unknowns via `.strict()`). This
 * wrapper only adds the two things a schema cannot: it parses the JSON string, and it
 * names the block in every error. Both matter because the value travels through `yq`,
 * `GITHUB_OUTPUT` and a workflow input before it arrives — a bare `SyntaxError: Unexpected
 * token 's'` would say nothing about where it came from.
 */
export function parseBlockConfig<S extends z.ZodTypeAny>(
  raw: string | undefined,
  schema: S,
  block: string,
): z.infer<S> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw ?? "{}");
  } catch (err) {
    throw new Error(
      `blockConfig for '${block}' is not valid JSON: ${(err as Error).message}. ` +
        `Received: ${raw}`,
    );
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(
      `blockConfig for '${block}' is invalid: ${detail}. Received: ${raw}`,
    );
  }

  return result.data;
}
