import { CfnResource } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { applyComponentTags } from "./platform-tags";

/**
 * How one project hands a live value to another.
 *
 *   /<companyId>/<environment>/<appId>/<block>/<role>/<OutputName>
 *   /up         /dev          /netw   /vpc    /main  /VpcId
 *
 * NOT an inventory. SSM holds current values and nothing else — no history, no intent, no
 * record of what exists. Those are answered by git (the manifests), CloudFormation (the
 * per-stack outputs) and the tag index, and duplicating any of them here would create the
 * one copy that can be wrong. What SSM does that none of them can is resolve a value
 * produced by one stack inside another stack, at deploy time.
 *
 * A component publishes NOTHING by default. Publishing every output of every component
 * would put an app team's own bucket ARN somewhere nothing will ever read it, and the store
 * would grow with every component until it stopped meaning anything. What reaches SSM is
 * declared per block in the catalog (`publishes:`, a subset of `outputs:`) and arrives here
 * inside the component spec, so the block itself still knows nothing about catalogs.
 *
 * Every segment of the path is a fact the request already carries, so a consumer can name a
 * dependency without looking anything up — and `GetParametersByPath /up/dev/netw/` answers
 * "what does the network publish?" in one call. That discovery property is the reason this
 * is SSM and not a CloudFormation export: an export would also create a hard cross-stack
 * dependency that freezes the producer's ability to ever change the value.
 */

export interface PublishContext {
  readonly companyId: string;
  readonly environment: string;
  readonly appId: string;
  readonly block: string;
  readonly role: string;
  readonly blockRef: string;
}

/** The path a consumer references. Exported because the platform composes the same string. */
export function composeParameterPath(ctx: PublishContext, outputName: string): string {
  return `/${ctx.companyId}/${ctx.environment}/${ctx.appId}/${ctx.block}/${ctx.role}/${outputName}`;
}

/**
 * Writes the declared subset of a component's outputs to SSM.
 *
 * @param outputs  everything the component produced, keyed by the catalog's output names
 * @param publishes  which of those may be consumed by another project. Empty or absent
 *                   means nothing is published, which is the default for every app block.
 */
export function publishComponentOutputs(
  scope: Construct,
  id: string,
  ctx: PublishContext,
  outputs: Record<string, string>,
  publishes?: readonly string[],
): void {
  if (!publishes || publishes.length === 0) return;

  // A catalog entry that publishes a name the block does not produce is a contract nobody
  // can satisfy: the parameter would be created holding `undefined`, and the consumer would
  // fail at deploy against a path that exists. Refused here, where the message can name both
  // sides, rather than at the far end of someone else's stack.
  const unknown = publishes.filter((name) => outputs[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `Block '${ctx.block}' is declared to publish ${unknown.map((n) => `'${n}'`).join(", ")}, ` +
        `but produces: ${Object.keys(outputs).sort().join(", ") || "(no outputs)"}. ` +
        `The catalog's 'publishes:' must be a subset of its 'outputs:'.`,
    );
  }

  // A container scope, tagged as the component it belongs to.
  //
  // This is NOT cosmetic. RequiredTagsAspect asserts the component-tier keys on every
  // CfnResource, and a parameter created directly in the stack's scope carries none of them
  // — the stack has no one block, ref or role to inherit from. Without this the first block
  // that ever publishes anything fails synth with "Missing required tag(s)", a long way from
  // the line that caused it.
  const published = new Construct(scope, id);
  applyComponentTags(published, {
    companyId: ctx.companyId,
    block: ctx.block,
    blockRef: ctx.blockRef,
    role: ctx.role,
  });

  for (const name of publishes) {
    const param = new StringParameter(published, name, {
      parameterName: composeParameterPath(ctx, name),
      stringValue: outputs[name],
      description: `${name} of ${ctx.appId}'s ${ctx.block} component '${ctx.role}' (${ctx.environment})`,
    });

    // Standard tier explicitly. The advanced tier costs money per parameter per month and
    // buys size and policies that a resource identifier does not need — a default that
    // changed underneath would be a silent bill.
    (param.node.defaultChild as CfnResource).addPropertyOverride("Tier", "Standard");
  }
}
