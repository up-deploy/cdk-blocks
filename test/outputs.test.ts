import { App, AspectPriority, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";
import { composeParameterPath } from "../lib/outputs";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";

const base = { companyId: "up", appId: "a231", environment: "dev" };
const s3 = (role: string, issueId: string, publishes?: string[]) => ({
  block: "s3",
  role,
  issueId,
  blockRef: "v0.5.0",
  config: { logBucket: "up-s3-logs-dev-01" },
  ...(publishes ? { publishes } : {}),
});

const stackOf = (components: ReturnType<typeof s3>[]) =>
  Template.fromStack(new AppStack(new App(), "App", { ...base, stackName: "up-a231-dev", components }));

describe("publishing a component's outputs to SSM", () => {
  test("POLICY: a component publishes NOTHING unless the catalog says so", () => {
    stackOf([s3("docs", "163")]).resourceCountIs("AWS::SSM::Parameter", 0);
  });

  test("POLICY: only the declared subset is published, not every output", () => {
    const template = stackOf([s3("docs", "163", ["BucketName"])]);

    template.resourceCountIs("AWS::SSM::Parameter", 1);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/up/dev/a231/s3/163/BucketName",
      Tier: "Standard",
    });
  });

  test("the path is <companyId>/<env>/<appId>/<block>/<issueId>/<output>", () => {
    expect(
      composeParameterPath(
        {
          companyId: "up",
          environment: "dev",
          appId: "netw",
          block: "vpc",
          role: "main",
          issueId: "42",
          blockRef: "v1",
        },
        "VpcId",
      ),
    ).toBe("/up/dev/netw/vpc/42/VpcId");
  });

  test.each([
    ["up:role", "docs"],
    ["up:block", "s3"],
    ["up:block-ref", "v0.5.0"],
    ["up:issue-id", "163"],
  ])("POLICY: a published parameter carries %s itself", (Key, Value) => {
    stackOf([s3("docs", "163", ["BucketName"])]).hasResourceProperties("AWS::SSM::Parameter", {
      Tags: Match.objectLike({ [Key]: Value }),
    });
  });

  test("POLICY: a published parameter satisfies RequiredTagsAspect end to end", () => {
    const app = new App();
    const stack = new AppStack(app, "App", {
      ...base,
      stackName: "up-a231-dev",
      components: [s3("docs", "163", ["BucketName", "BucketArn"])],
    });
    applyPlatformTags(app, { companyId: "up", appId: "a231", environment: "dev", extra: {} });
    Aspects.of(app).add(new RequiredTagsAspect("up"), { priority: AspectPriority.READONLY });

    Annotations.fromStack(stack).hasNoError("*", Match.stringLikeRegexp("Missing required tag"));
    Template.fromStack(stack).resourceCountIs("AWS::SSM::Parameter", 2);
  });

  test("POLICY: publishing an output the block does not produce is refused", () => {
    expect(() => stackOf([s3("docs", "163", ["VpcId"])])).toThrow(
      /declared to publish 'VpcId'.*produces: BucketArn, BucketName.*subset/s,
    );
  });

  test("two components publish to paths that do not collide", () => {
    const template = stackOf([
      s3("docs", "163", ["BucketName"]),
      s3("upload", "170", ["BucketName"]),
    ]);
    template.resourceCountIs("AWS::SSM::Parameter", 2);
    for (const name of ["/up/dev/a231/s3/163/BucketName", "/up/dev/a231/s3/170/BucketName"]) {
      template.hasResourceProperties("AWS::SSM::Parameter", { Name: name });
    }
  });

  test("publishes survives the request parser and rejects a non-list", () => {
    expect(parseComponents(JSON.stringify([s3("docs", "163", ["BucketName"])]))[0].publishes).toEqual([
      "BucketName",
    ]);
    expect(() =>
      parseComponents(JSON.stringify([{ ...s3("docs", "163"), publishes: "BucketName" }])),
    ).toThrow(/components is not a valid component list/);
  });
});
