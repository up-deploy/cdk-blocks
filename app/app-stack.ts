import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ComponentSpec } from "./component-spec";
import { factoryFor } from "./registry";
import { publishComponentOutputs } from "../lib/outputs";

export interface AppStackProps extends StackProps {
  readonly companyId: string;
  readonly appId: string;
  readonly environment: string;
  readonly components: ComponentSpec[];
}

/**
 * ONE stack per app team, per environment.
 *
 * The unit of deployment is the team, not the resource. Asking for a second component updates
 * this stack instead of creating an unrelated one, which is what makes the change set worth an
 * approver's time: it says "adding a table to your existing app", not "create everything".
 *
 * The trade is stated rather than hidden: a failed update rolls back the team's whole stack,
 * and CloudFormation caps a stack at 500 resources. Both are acceptable at one app's scale and
 * both are reasons to split by lifecycle later, never by resource type.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    for (const spec of props.components) {
      // The construct id is what CloudFormation logical IDs are derived from, so it must be
      // stable and unique per component. (block, role) is exactly the tuple that already
      // guarantees a unique resource name, so reusing it keeps the two from disagreeing.
      const componentId = `${pascal(spec.block)}${pascal(spec.role)}`;

      const { resourceName, outputs } = factoryFor(spec.block)(this, componentId, {
        companyId: props.companyId,
        appId: props.appId,
        environment: props.environment,
        role: spec.role,
        blockRef: spec.blockRef,
        config: spec.config,
      });

      // The composed name, as an output, so the platform can READ it instead of recomputing it.
      // It is what a requester is shown as "what you got", and the only honest source for that is
      // the thing that built it — a second implementation of the formula in the platform would
      // agree until one of the two changed.
      //
      // Not routed through `outputs`: those are the block's declared public surface, listed in the
      // catalog and asserted by tests. This is the platform's own plumbing and does not belong in
      // a contract app teams read.
      new CfnOutput(this, `${componentId}ResourceName`, {
        value: resourceName,
        description: `The composed name of the ${spec.block} component '${spec.role}'`,
      });

      // The catalog declares output names per block (`outputs: [BucketName, BucketArn]`), and one
      // stack holds many components, so the declared name is a SUFFIX on the component's id:
      // `S3DocsBucketName`, never `BucketName`, which every component would claim.
      //
      // The prefix is `componentId` — block AND role — because it was ROLE ALONE and that was a
      // bug waiting for a second block. `ComponentListSchema` refuses duplicates on `(block,
      // role)`, so `{s3, main}` and `{vpc, main}` is a LEGAL app; both would then have tried to
      // create `MainResourceName`, and CDK refuses a duplicate construct id at synth. The check
      // guarded one key while the ids used another. They are now the same key, so they cannot
      // disagree again.
      //
      // Fixed while only `s3` is registered and nothing is deployed, which is the only window
      // where renaming an output costs nothing. The platform is unaffected: `manifest-pr.yml`
      // selects with `endswith("ResourceName")`, a suffix match that a prefix change cannot break.
      for (const [name, value] of Object.entries(outputs)) {
        new CfnOutput(this, `${componentId}${name}`, {
          value,
          description: `${name} of the ${spec.block} component '${spec.role}'`,
        });
      }

      // CloudFormation outputs are the complete per-stack record and cost nothing, so every
      // output gets one. SSM is a different question — not "what did this stack make?" but
      // "what may another project consume?" — and it is answered by the catalog, per block,
      // defaulting to nothing. Done here rather than in the factory so no block author can
      // forget it, and so a block stays ignorant of the platform that publishes for it.
      publishComponentOutputs(
        this,
        `${componentId}Published`,
        {
          companyId: props.companyId,
          environment: props.environment,
          appId: props.appId,
          block: spec.block,
          role: spec.role,
          blockRef: spec.blockRef,
        },
        outputs,
        spec.publishes,
      );
    }

    // ── the ceiling an app actually hits ────────────────────────────────────────────────
    //
    // The limit everyone quotes for a stack is 500 RESOURCES. It is not the one that binds here.
    // CloudFormation also caps a template at 200 OUTPUTS, and every component contributes its
    // composed name plus each output its catalog entry declares — three for `s3` — so an app
    // team runs out of outputs at roughly 66 components while still under 250 resources.
    //
    // Counted from the constructs that actually exist, never as `components.length * 3`: a block
    // that declares a third output must not require a second place to be updated to stay honest.
    //
    // FAILS rather than warns, and there is no third option. `Annotations.addWarning` becomes an
    // `aws:cdk:warning` in the cloud assembly, which `scan-verdict.sh` reads and fails the request
    // on — a warning here would be a failure wearing a softer word. Any other channel (`addInfo`,
    // a `console.error`) is read by nothing, which is this platform's oldest failure shape:
    // absence looking like success.
    //
    // Failing costs nothing: it happens at synth, on the pull request, before the merge, and the
    // `ready` job leaves that PR a draft. CloudFormation enforces the same number anyway — but at
    // deploy, mid-update, rolling back the whole app team's stack.
    //
    // ⚠️ Outputs bind first FOR THE BLOCKS REGISTERED TODAY. A block with a high resource-to-output
    // ratio — a VPC is thirty-odd resources and two outputs — flips which limit arrives first, and
    // at that point the 500-resource cap wants these same three lines.
    const OUTPUT_QUOTA = 200;
    const outputCount = this.node.findAll().filter((c) => c instanceof CfnOutput).length;
    if (outputCount > OUTPUT_QUOTA) {
      throw new Error(
        `App '${props.appId}' composes ${outputCount} stack outputs in '${props.environment}', ` +
          `over CloudFormation's limit of ${OUTPUT_QUOTA} per stack. That limit, not the ` +
          `500-resource one, is what an app hits first: each component contributes its composed ` +
          `name plus every output its block declares. The fix is a second app — a second appId ` +
          `with its own stack — not a bigger one; this stack is already the unit of deployment ` +
          `for one team.`,
      );
    }
  }
}

/** Logical IDs admit alphanumerics only, and every segment here is already [a-z0-9-]. */
function pascal(value: string): string {
  return value
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
