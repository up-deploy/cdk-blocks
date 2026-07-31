import { z } from "zod";
import { ROLE_PATTERN, SEQ_PATTERN } from "../lib/naming";

/**
 * What one app asks for: a list of components.
 *
 * This replaces `-c blockConfig` + `-c blockRef` + `-c role`, which could only ever describe ONE
 * component because the pipeline built one stack per block. An app team's stack holds several,
 * so the request is a list and every per-component value moves inside it.
 *
 * The list is composed by the platform from `apps/<appId>/<env>.yaml`, the catalog pin and the
 * environment file. This repo stays client-agnostic: it receives the list, it does not read it
 * off disk.
 */
export const ComponentSpecSchema = z
  .object({
    /** Catalog entry name. Must exist in the registry, or synth fails. */
    block: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase catalog name"),
    /** What this component is for. Name segment and tag. */
    role: z.string().regex(ROLE_PATTERN, "must be lowercase, no hyphens, 3-12 characters"),
    /** Two digits. Omitted means `01`. */
    seq: z.string().regex(SEQ_PATTERN, "must be exactly two digits, e.g. '01'").optional(),
    /** The catalog's source.ref for this block. Per component: two blocks pin independently. */
    blockRef: z.string().min(1),
    /**
     * The block's own config blob, class 2, from the environment file. Left as `unknown` here
     * because only the block knows its schema — each factory parses it with its own.
     */
    config: z.unknown().optional(),
  })
  .strict();

export const ComponentListSchema = z
  .array(ComponentSpecSchema)
  .min(1, "an app must request at least one component")
  // Two components with the same block, role and seq would compose the same resource name.
  // Caught here rather than at deploy, where it surfaces as a duplicate-name error from AWS.
  .superRefine((components, ctx) => {
    const seen = new Set<string>();
    for (const c of components) {
      const key = `${c.block}/${c.role}/${c.seq ?? "01"}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Duplicate component '${key}' — two components with the same block, role and seq ` +
            `compose the same resource name. Give one a different role, or bump its seq.`,
        });
      }
      seen.add(key);
    }
  });

export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

/** Parses the `-c components` context blob loudly, the way blockConfig and tags are parsed. */
export function parseComponents(raw?: string): ComponentSpec[] {
  if (raw === undefined || raw === "") {
    throw new Error("components is required — the app requested nothing to build");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`components is not valid JSON: ${msg}. Received: ${raw}`);
  }

  const result = ComponentListSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`components is not a valid component list — ${detail}`);
  }

  return result.data;
}
