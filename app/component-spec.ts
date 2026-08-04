import { z } from "zod";
import { ISSUE_ID_PATTERN, ROLE_PATTERN } from "../lib/naming";

/**
 * What one app asks for: a list of components.
 *
 * The list is composed by the platform from `apps/<appId>/<env>.yaml`, the catalog pin and the
 * environment file. This repo stays client-agnostic: it receives the list, it does not read it
 * off disk.
 */
export const ComponentSpecSchema = z
  .object({
    /** Catalog entry name. Must exist in the registry, or synth fails. */
    block: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase catalog name"),
    /**
     * Optional purpose hint (name segment + tag). Uniqueness is carried by issueId —
     * see lib/naming.ts.
     */
    role: z
      .string()
      .regex(ROLE_PATTERN, "must be lowercase, no hyphens, 1-6 characters")
      .optional(),
    /**
     * GitHub issue number of the change request that added this component. Immutable.
     * Part of the physical name and the construct id.
     */
    issueId: z.string().regex(ISSUE_ID_PATTERN, "must be a GitHub issue number (no leading zeros)"),
    /** The catalog's source.ref for this block. Per component: two blocks pin independently. */
    blockRef: z.string().min(1),
    /**
     * Which of this component's outputs may be consumed by ANOTHER project, from the
     * catalog's `publishes:`. Absent means nothing is published, which is the default and
     * what every app block should have — see lib/outputs.ts.
     *
     * It arrives in the request rather than being read from the catalog here, because this
     * repo knows nothing about catalogs: the platform decides what is publishable, the block
     * only writes what it is told to.
     */
    publishes: z.array(z.string().min(1)).optional(),
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
  // Two components with the same (block, role-or-empty, issueId) would compose the same name.
  .superRefine((components, ctx) => {
    const seen = new Set<string>();
    for (const c of components) {
      const roleKey = c.role ?? "";
      const key = `${c.block}/${roleKey}/${c.issueId}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Duplicate component '${key}' — two components with the same block, role and ` +
            `issueId compose the same resource name. Each change request must add a distinct ` +
            `component (a new issueId), or give one an optional role that says what it is for.`,
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
