import { App, AspectPriority, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";
import { composeParameterPath } from "../lib/outputs";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";

const base = { companyId: "up", appId: "a231", environment: "dev" };
const s3 = (role: string, publishes?: string[]) => ({
  block: "s3",
  role,
  blockRef: "v0.5.0",
  config: { logBucket: "up-s3-logs-dev-01" },
  ...(publishes ? { publishes } : {}),
});

const stackOf = (components: ReturnType<typeof s3>[]) =>
  Template.fromStack(new AppStack(new App(), "App", { ...base, stackName: "up-a231-dev", components }));

describe("publishing a component's outputs to SSM", () => {
  // POLICY: this is the default, and it is the whole answer to "would SSM become huge?".
  // An app team's own bucket is nobody else's business, and a parameter nothing reads is a
  // store that grows with every component until it stops meaning anything.
  test("POLICY: a component publishes NOTHING unless the catalog says so", () => {
    stackOf([s3("docs")]).resourceCountIs("AWS::SSM::Parameter", 0);
  });

  test("POLICY: only the declared subset is published, not every output", () => {
    const template = stackOf([s3("docs", ["BucketName"])]);

    // The block produces BucketName AND BucketArn; only one was declared.
    template.resourceCountIs("AWS::SSM::Parameter", 1);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/up/dev/a231/s3/docs/BucketName",
      Tier: "Standard",
    });
  });

  test("the path is <companyId>/<env>/<appId>/<block>/<role>/<output>", () => {
    expect(
      composeParameterPath(
        { companyId: "up", environment: "dev", appId: "netw", block: "vpc", role: "main", blockRef: "v1" },
        "VpcId",
      ),
    ).toBe("/up/dev/netw/vpc/main/VpcId");
  });

  // The component tier, applied by the container scope this module creates. The app tier
  // (`up:managed`, `up:app-id`, `up:env`) comes from app.ts and is asserted below, where the
  // whole entrypoint's tagging is reproduced.
  test.each([
    ["up:role", "docs"],
    ["up:block", "s3"],
    ["up:block-ref", "v0.5.0"],
  ])("POLICY: a published parameter carries %s itself", (Key, Value) => {
    stackOf([s3("docs", ["BucketName"])]).hasResourceProperties("AWS::SSM::Parameter", {
      Tags: Match.objectLike({ [Key]: Value }),
    });
  });

  // POLICY: this is the tagging trap, and it is the reason lib/outputs.ts creates a tagged
  // container scope instead of building parameters in the stack's own scope.
  //
  // RequiredTagsAspect asserts all six keys on EVERY CfnResource. A parameter created
  // directly under the stack inherits none of the component-tier ones — the stack has no
  // single block, ref or role to give it — so the first block that ever published anything
  // would fail synth with "Missing required tag(s)", a long way from the line responsible.
  // Reproducing app.ts's tagging here and asserting NO error is what keeps that fixed.
  test("POLICY: a published parameter satisfies RequiredTagsAspect end to end", () => {
    const app = new App();
    const stack = new AppStack(app, "App", {
      ...base,
      stackName: "up-a231-dev",
      components: [s3("docs", ["BucketName", "BucketArn"])],
    });
    applyPlatformTags(app, { companyId: "up", appId: "a231", environment: "dev", extra: {} });
    Aspects.of(app).add(new RequiredTagsAspect("up"), { priority: AspectPriority.READONLY });

    Annotations.fromStack(stack).hasNoError("*", Match.stringLikeRegexp("Missing required tag"));
    Template.fromStack(stack).resourceCountIs("AWS::SSM::Parameter", 2);
  });

  // POLICY: a catalog that promises an output the block does not produce is a contract
  // nobody can satisfy. Caught here, where the message can name both sides, rather than at
  // the far end of a consuming stack that resolves a path holding nothing.
  test("POLICY: publishing an output the block does not produce is refused", () => {
    expect(() => stackOf([s3("docs", ["VpcId"])])).toThrow(
      /declared to publish 'VpcId'.*produces: BucketArn, BucketName.*subset/s,
    );
  });

  test("two components publish to paths that do not collide", () => {
    const template = stackOf([s3("docs", ["BucketName"]), s3("uploads", ["BucketName"])]);
    template.resourceCountIs("AWS::SSM::Parameter", 2);
    for (const name of ["/up/dev/a231/s3/docs/BucketName", "/up/dev/a231/s3/uploads/BucketName"]) {
      template.hasResourceProperties("AWS::SSM::Parameter", { Name: name });
    }
  });

  test("publishes survives the request parser and rejects a non-list", () => {
    expect(parseComponents(JSON.stringify([s3("docs", ["BucketName"])]))[0].publishes).toEqual([
      "BucketName",
    ]);
    expect(() => parseComponents(JSON.stringify([{ ...s3("docs"), publishes: "BucketName" }]))).toThrow(
      /components is not a valid component list/,
    );
  });
});
