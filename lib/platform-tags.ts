import { Annotations, IAspect, TagManager, Tags } from "aws-cdk-lib";
import { IConstruct } from "constructs";

/**
 * Implements the contract in up-platform's docs/tagging-schema.md.
 *
 * Every key is namespaced `<companyId>:`. companyId is a platform-config value, not a constant,
 * because the client model is a full private copy of this repo in the client's own org — a fixed
 * prefix would make two installs emit identical keys in a shared payer account.
 */

/** Keys the platform emits itself. Required on every taggable resource, never supplied by config. */
const PLATFORM_KEYS = ["managed", "app-id", "env", "block", "block-ref"] as const;

/**
 * Keys config may never supply. The platform keys, plus `companyid`: it IS the prefix, so emitting
 * it as a key too would be redundant and confusing. Every other casing of it fails KEY_PATTERN.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set<string>([...PLATFORM_KEYS, "companyid"]);

/**
 * Bare, lowercase, hyphen-separated. Tag keys are case sensitive, so `CostCenter`, `costCenter` and
 * `costcenter` are three different tags; one casing rule is cheaper than remembering which was used.
 *
 * Admitting no colon also makes the schema's "no `aws:` prefix" rule free, and stops config from
 * writing the namespace itself — exactly one place in this codebase knows what the prefix is.
 */
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface PlatformTagOptions {
  /** Tag namespace, from config/environments/<env>.yaml. */
  readonly companyId: string;
  /** Class 1, from the issue form via the router. */
  readonly appId: string;
  /** Class 2, the environment ring. */
  readonly environment: string;
  /** The catalog entry name. */
  readonly block: string;
  /** The catalog's source.ref. Records which version of the block built the resource. */
  readonly blockRef: string;
  /** Class 2, free-form keys from the env file's `tags:` map. Supplied bare; prefixed here. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Applies the platform tag set to every taggable resource under `scope`.
 *
 * Throws rather than annotating: a bad key is a config error, and there is nothing useful to
 * synthesize past it.
 */
export function applyPlatformTags(scope: IConstruct, opts: PlatformTagOptions): void {
  const ns = (key: string) => `${opts.companyId}:${key}`;
  const tags = Tags.of(scope);

  tags.add(ns("managed"), "true");
  tags.add(ns("app-id"), opts.appId);
  tags.add(ns("env"), opts.environment);
  tags.add(ns("block"), opts.block);
  tags.add(ns("block-ref"), opts.blockRef);

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid tag key '${key}' in the environment's tags: map — keys must be bare and match ` +
          `${KEY_PATTERN.source} (lowercase, hyphen-separated, no namespace prefix)`,
      );
    }
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `Reserved tag key '${key}' in the environment's tags: map — the block emits it. ` +
          `Setting it here would overwrite a per-request value with a per-environment constant.`,
      );
    }
    tags.add(ns(key), String(value));
  }
}

/**
 * Fails synth if any taggable resource is missing a required key.
 *
 * applyPlatformTags validates its inputs; this covers what input validation cannot — a resource that
 * ends up untagged anyway. `Tags.of()` skips non-taggable nodes in total silence, so coverage is
 * asserted rather than assumed. One untagged resource is a hole in the index, and "tags are the
 * index, AWS is the database" quietly stops being true.
 *
 * MUST be registered at AspectPriority.READONLY. Tag aspects register at DEFAULT (500) here, since
 * cdk.json sets no feature flags; at the same priority this would inspect nodes before the tags land.
 */
export class RequiredTagsAspect implements IAspect {
  private readonly required: string[];

  constructor(companyId: string) {
    this.required = PLATFORM_KEYS.map((key) => `${companyId}:${key}`);
  }

  public visit(node: IConstruct): void {
    // Both flavours, the way CDK's own Tag.visit does it: CfnBucket is v1, but other L1s in the
    // same synth are v2. Checking only one silently skips part of the tree.
    const manager = TagManager.isTaggableV2(node)
      ? node.cdkTagManager
      : TagManager.isTaggable(node)
        ? node.tags
        : undefined;

    if (!manager) {
      return;
    }

    const present = manager.tagValues();
    const missing = this.required.filter((key) => present[key] === undefined);

    if (missing.length > 0) {
      Annotations.of(node).addError(
        `Missing required tag(s): ${missing.join(", ")} — see docs/tagging-schema.md`,
      );
    }
  }
}
