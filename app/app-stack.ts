import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ComponentSpec } from "./component-spec";
import { factoryFor } from "./registry";
import { DEFAULT_SEQ } from "../lib/naming";

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
      const seq = spec.seq ?? DEFAULT_SEQ;

      // The construct id is what CloudFormation logical IDs are derived from, so it must be
      // stable and unique per component. (block, role, seq) is exactly the tuple that already
      // guarantees a unique resource name, so reusing it keeps the two from disagreeing.
      const componentId = `${pascal(spec.block)}${pascal(spec.role)}${seq}`;

      const outputs = factoryFor(spec.block)(this, componentId, {
        companyId: props.companyId,
        appId: props.appId,
        environment: props.environment,
        role: spec.role,
        seq: spec.seq,
        blockRef: spec.blockRef,
        config: spec.config,
      });

      // The catalog declares output names per block (`outputs: [BucketName, BucketArn]`), and
      // one stack can now hold two of the same block, so the declared name becomes a SUFFIX.
      // `Docs01BucketName` rather than `BucketName`, which two components would both claim.
      for (const [name, value] of Object.entries(outputs)) {
        new CfnOutput(this, `${pascal(spec.role)}${seq}${name}`, {
          value,
          description: `${name} of the ${spec.block} component '${spec.role}' (${seq})`,
        });
      }
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
