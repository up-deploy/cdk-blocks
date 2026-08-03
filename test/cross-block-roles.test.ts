import { App, CfnResource } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";
import { REGISTRY, ComponentFactory } from "../app/registry";

/**
 * The sibling of "two components with the same block and role are refused" in app-stack.test.ts.
 * That one proves a duplicate is rejected; this one proves the NON-duplicate is accepted.
 *
 * `ComponentListSchema` refuses duplicates on `(block, role)`, so `{s3, main}` and `{vpc, main}`
 * is a legal app — and it was a synth failure, because output ids were keyed on role ALONE while
 * construct ids used block+role. Both components tried to create `MainResourceName`, and CDK
 * refuses a duplicate construct id. The check guarded one key and the ids used another.
 *
 * Unreachable in production while `s3` is the only registered block, which is exactly why it is
 * worth a test: the day a second block is registered is the day it becomes a live bug, and
 * nothing else in the suite would have been red before then.
 *
 * A separate FILE rather than a describe block, because proving it needs a second block in the
 * registry, and jest gives each test file its own module registry — so the stub below cannot
 * leak into the "Unknown block" assertion elsewhere, which reads the registry's key list.
 */

const base = { companyId: "up", appId: "a231", environment: "dev" };

// Test-only. There is no second real block yet, and waiting for one would mean shipping the fix
// with no red path behind it.
const fakeFactory: ComponentFactory = (scope, id, ctx) => {
  new CfnResource(scope, `${id}Thing`, { type: "AWS::CloudFormation::WaitConditionHandle" });
  return {
    resourceName: `up-fake-${ctx.appId}-${ctx.role}-${ctx.environment}`,
    outputs: { FakeId: "fake-id" },
  };
};

describe("one role, two blocks", () => {
  beforeAll(() => {
    (REGISTRY as Record<string, ComponentFactory>).fake = fakeFactory;
  });

  afterAll(() => {
    delete (REGISTRY as Record<string, ComponentFactory>).fake;
  });

  // POLICY: `role` says what a resource is FOR, and two different blocks can legitimately serve
  // the same purpose. The catalog's own guidance is to pick the purpose rather than the
  // technology, so forcing `mainvpc` to dodge a collision would put the technology back.
  test("POLICY: two components of DIFFERENT blocks may share a role", () => {
    const components = parseComponents(
      JSON.stringify([
        { block: "s3", role: "main", blockRef: "v0.6.0", config: { logBucket: "up-s3-logs-dev-01" } },
        { block: "fake", role: "main", blockRef: "v0.6.0" },
      ]),
    );

    const stack = new AppStack(new App(), "App", { ...base, stackName: "up-a231-dev", components });
    const template = Template.fromStack(stack);

    // Both survive, distinguished by the block in their id. On the pre-fix code this whole test
    // throws "There is already a Construct with name 'MainResourceName'".
    template.hasOutput("S3MainResourceName", { Value: "up-s3-a231-main-dev" });
    template.hasOutput("FakeMainResourceName", { Value: "up-fake-a231-main-dev" });
    template.hasOutput("S3MainBucketName", {});
    template.hasOutput("FakeMainFakeId", {});
  });
});
