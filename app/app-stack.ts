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
      new CfnOutput(this, `${pascal(spec.role)}ResourceName`, {
        value: resourceName,
        description: `The composed name of the ${spec.block} component '${spec.role}'`,
      });

      // The catalog declares output names per block (`outputs: [BucketName, BucketArn]`), and
      // one stack can hold two of the same block, so the declared name becomes a SUFFIX.
      // `DocsBucketName` rather than `BucketName`, which two components would both claim.
      for (const [name, value] of Object.entries(outputs)) {
        new CfnOutput(this, `${pascal(spec.role)}${name}`, {
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
