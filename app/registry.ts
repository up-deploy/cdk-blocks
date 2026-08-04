import { Construct } from "constructs";
import { parseBlockConfig } from "../lib/block-config";
import { S3Bucket, S3ConfigSchema } from "../blocks/s3/s3-bucket";

/**
 * Which block names are buildable, and how.
 *
 * This replaces `bin/<name>.ts` as the selection contract. A file in `bin/` made a block
 * requestable by existing; now a block is requestable by being registered here, which is a
 * deliberate line of code rather than a side effect of where a file was saved.
 *
 * A name the registry does not know fails at synth with a message naming what IS known, so a
 * catalog entry that outruns the code cannot render as an empty stack.
 */

export interface ComponentContext {
  readonly companyId: string;
  readonly appId: string;
  readonly environment: string;
  /** Optional purpose hint. */
  readonly role?: string;
  /** Change-request issue id — part of the physical name. */
  readonly issueId: string;
  readonly blockRef: string;
  /** The block's config blob, still unparsed — only the block knows its schema. */
  readonly config: unknown;
}

export interface ComponentResult {
  /**
   * The composed resource name, as a plain string.
   *
   * Returned rather than left for the platform to recompute. The platform holds every segment
   * (`companyId`, `block`, `appId`, `role?`, `env`, `issueId`) and could rebuild it in bash —
   * which would put a second copy of `lib/naming.ts`'s formula outside this repo, agreeing with
   * the first until one of them changed. The block already composed it; handing it back costs
   * nothing and leaves exactly one definition.
   */
  readonly resourceName: string;
  /** The values worth exposing as stack outputs, keyed by the names the catalog declares. */
  readonly outputs: Record<string, string>;
}

/**
 * Builds one component and returns its name plus the values worth exposing as stack outputs,
 * keyed by the names the catalog declares in `outputs:`. The stack, not the component, decides
 * how those names are made unique.
 */
export type ComponentFactory = (
  scope: Construct,
  id: string,
  ctx: ComponentContext,
) => ComponentResult;

export const REGISTRY: Readonly<Record<string, ComponentFactory>> = {
  s3: (scope, id, ctx) => {
    const cfg = parseBlockConfig(
      ctx.config === undefined ? undefined : JSON.stringify(ctx.config),
      S3ConfigSchema,
      "s3",
    );

    const component = new S3Bucket(scope, id, {
      companyId: ctx.companyId,
      appId: ctx.appId,
      environment: ctx.environment,
      role: ctx.role,
      issueId: ctx.issueId,
      blockRef: ctx.blockRef,
      cfg,
    });

    return {
      resourceName: component.resourceName,
      outputs: {
        BucketName: component.bucket.bucketName,
        BucketArn: component.bucket.bucketArn,
      },
    };
  },
};

export function factoryFor(block: string): ComponentFactory {
  const factory = REGISTRY[block];
  if (!factory) {
    throw new Error(
      `Unknown block '${block}' — this version of cdk-blocks builds: ${Object.keys(REGISTRY)
        .sort()
        .join(", ")}. Either the catalog offers a block this ref predates, or the name is wrong.`,
    );
  }
  return factory;
}
