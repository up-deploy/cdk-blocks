import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";

const base = { companyId: "up", appId: "a231", environment: "dev" };
const s3 = (role: string) => ({
  block: "s3",
  role,
  blockRef: "v0.3.0",
  config: { logBucket: "up-s3-logs-dev-01" },
});

describe("one stack per app, holding many components", () => {
  const app = new App();
  const stack = new AppStack(app, "App", {
    ...base,
    stackName: "up-a231-dev",
    components: [s3("docs"), s3("uploads"), s3("docsarchive")],
  });
  const template = Template.fromStack(stack);

  // POLICY: the unit of deployment is the app team, not the resource. Three requests from one
  // team are three resources in ONE stack, which is what makes a change set incremental.
  test("POLICY: three components produce one stack with three buckets", () => {
    template.resourceCountIs("AWS::S3::Bucket", 3);
    expect(stack.stackName).toBe("up-a231-dev");
  });

  test("each component composes its own name from its role", () => {
    for (const name of [
      "up-s3-a231-docs-dev",
      "up-s3-a231-uploads-dev",
      "up-s3-a231-docsarchive-dev",
    ]) {
      template.hasResourceProperties("AWS::S3::Bucket", { BucketName: name });
    }
  });

  // POLICY: outputs are scoped per component. Two buckets both claiming `BucketName` would
  // leave the second silently overwriting the first.
  test("POLICY: outputs are unique per component", () => {
    for (const id of ["DocsBucketName", "UploadsBucketName", "DocsarchiveBucketName"]) {
      template.hasOutput(id, {});
    }
  });

  test("each bucket carries its own role tag", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-a231-uploads-dev",
      Tags: Match.arrayWith([{ Key: "up:role", Value: "uploads" }]),
    });
  });
});

describe("the component list is validated before anything is built", () => {
  test("an unknown block names what this ref can build", () => {
    const app = new App();
    expect(
      () =>
        new AppStack(app, "App", {
          ...base,
          components: [{ block: "dynamodb", role: "sessions", blockRef: "v0.3.0" }],
        }),
    ).toThrow(/Unknown block 'dynamodb'.*builds: s3/s);
  });

  // POLICY: (block, role) is what guarantees a unique resource name, so a duplicate is refused
  // at parse time rather than surfacing as a duplicate-name error from AWS at deploy. The fix
  // is a role that says what the second one is FOR — the platform does not number around it.
  test("POLICY: two components with the same block and role are refused", () => {
    const raw = JSON.stringify([s3("docs"), s3("docs")]);
    expect(() => parseComponents(raw)).toThrow(/Duplicate component 's3\/docs'/);
  });

  // POLICY: `seq` was removed in v0.5.0. Because the spec is `.strict()`, a manifest that still
  // carries it fails by name instead of being silently ignored — which is the whole point of
  // dropping a field rather than accepting-and-discarding it.
  test("POLICY: a component still carrying seq is refused", () => {
    const raw = JSON.stringify([{ ...s3("docs"), seq: "01" }]);
    expect(() => parseComponents(raw)).toThrow(/components is not a valid component list/);
  });

  test("a role with a hyphen is refused by the spec, not only by the name composer", () => {
    const raw = JSON.stringify([s3("user-docs")]);
    expect(() => parseComponents(raw)).toThrow(/no hyphens/);
  });

  test("an empty component list is refused", () => {
    expect(() => parseComponents("[]")).toThrow(/at least one component/);
    expect(() => parseComponents(undefined)).toThrow(/components is required/);
  });

  test("an unknown key in a component is refused", () => {
    const raw = JSON.stringify([{ ...s3("docs"), instance: "01" }]);
    expect(() => parseComponents(raw)).toThrow(/components is not a valid component list/);
  });

  test("malformed JSON says what it received", () => {
    expect(() => parseComponents("not json")).toThrow(/components is not valid JSON.*Received: not json/s);
  });
});
