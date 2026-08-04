import { App, CfnResource } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";
import { REGISTRY, ComponentFactory } from "../app/registry";

/**
 * The sibling of "two components with the same block, role and issueId are refused".
 * Proves two DIFFERENT blocks may share a role (and would collide if ids used role alone).
 */

const base = { companyId: "up", appId: "a231", environment: "dev" };

const fakeFactory: ComponentFactory = (scope, id, ctx) => {
  new CfnResource(scope, `${id}Thing`, { type: "AWS::CloudFormation::WaitConditionHandle" });
  return {
    resourceName: `up-fake-${ctx.appId}-${ctx.role ?? "x"}-${ctx.environment}-${ctx.issueId}`,
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

  test("POLICY: two components of DIFFERENT blocks may share a role", () => {
    const components = parseComponents(
      JSON.stringify([
        {
          block: "s3",
          role: "main",
          issueId: "163",
          blockRef: "v0.6.0",
          config: { logBucket: "up-s3-logs-dev-01" },
        },
        { block: "fake", role: "main", issueId: "164", blockRef: "v0.6.0" },
      ]),
    );

    const stack = new AppStack(new App(), "App", { ...base, stackName: "up-a231-dev", components });
    const template = Template.fromStack(stack);

    template.hasOutput("S3Main163ResourceName", { Value: "up-s3-a231-main-dev-163" });
    template.hasOutput("FakeMain164ResourceName", { Value: "up-fake-a231-main-dev-164" });
    template.hasOutput("S3Main163BucketName", {});
    template.hasOutput("FakeMain164FakeId", {});
  });
});
