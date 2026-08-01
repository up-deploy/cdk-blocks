import { z } from "zod";
import { ROLE_PATTERN } from "../lib/naming";

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
    /**
     * What this component is for. Name segment, tag, and the ONLY thing separating two
     * components of the same block. There is deliberately no sequence number behind it —
     * see lib/naming.ts for why the name is a pure function of the request.
     */
    role: z.string().regex(ROLE_PATTERN, "must be lowercase, no hyphens, 3-12 characters"),
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
  // Two components with the same block and role would compose the same resource name.
  // Caught here rather than at deploy, where it surfaces as a duplicate-name error from AWS.
  .superRefine((components, ctx) => {
    const seen = new Set<string>();
    for (const c of components) {
      const key = `${c.block}/${c.role}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Duplicate component '${key}' — two components with the same block and role compose ` +
            `the same resource name. Give one a role that says what it is for, e.g. 'uploads' ` +
            `or 'docsarchive'.`,
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
