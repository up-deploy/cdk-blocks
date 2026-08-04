import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";
import { parseComponents } from "../app/component-spec";

const base = { companyId: "up", appId: "a231", environment: "dev" };
const s3 = (role: string, issueId: string) => ({
  block: "s3",
  role,
  issueId,
  blockRef: "v0.3.0",
  config: { logBucket: "up-s3-logs-dev-01" },
});

describe("one stack per app, holding many components", () => {
  const app = new App();
  const stack = new AppStack(app, "App", {
    ...base,
    stackName: "up-a231-dev",
    components: [s3("docs", "163"), s3("upload", "170"), s3("arch", "171")],
  });
  const template = Template.fromStack(stack);

  // POLICY: the unit of deployment is the app team, not the resource. Three requests from one
  // team are three resources in ONE stack, which is what makes a change set incremental.
  test("POLICY: three components produce one stack with three buckets", () => {
    template.resourceCountIs("AWS::S3::Bucket", 3);
    expect(stack.stackName).toBe("up-a231-dev");
  });

  test("each component composes its own name from role and issueId", () => {
    for (const name of [
      "up-s3-a231-docs-dev-163",
      "up-s3-a231-upload-dev-170",
      "up-s3-a231-arch-dev-171",
    ]) {
      template.hasResourceProperties("AWS::S3::Bucket", { BucketName: name });
    }
  });

  // POLICY: outputs are scoped per component. Two buckets both claiming `BucketName` would
  // leave the second silently overwriting the first.
  test("POLICY: outputs are unique per component", () => {
    for (const id of ["S3Docs163BucketName", "S3Upload170BucketName", "S3Arch171BucketName"]) {
      template.hasOutput(id, {});
    }
  });

  // POLICY: the composed name is emitted so the PLATFORM can read it rather than recompute it.
  test.each([
    ["S3Docs163ResourceName", "up-s3-a231-docs-dev-163"],
    ["S3Upload170ResourceName", "up-s3-a231-upload-dev-170"],
    ["S3Arch171ResourceName", "up-s3-a231-arch-dev-171"],
  ])("POLICY: %s carries the composed name for the platform to read", (id, name) => {
    template.hasOutput(id, { Value: name });
  });

  test("each bucket carries its own role tag", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-a231-upload-dev-170",
      Tags: Match.arrayWith([{ Key: "up:role", Value: "upload" }]),
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
          components: [{ block: "dynamodb", role: "sess", issueId: "1", blockRef: "v0.3.0" }],
        }),
    ).toThrow(/Unknown block 'dynamodb'.*builds: s3/s);
  });

  // POLICY: (block, role-or-empty, issueId) guarantees a unique resource name.
  test("POLICY: two components with the same block, role and issueId are refused", () => {
    const raw = JSON.stringify([s3("docs", "163"), s3("docs", "163")]);
    expect(() => parseComponents(raw)).toThrow(/Duplicate component 's3\/docs\/163'/);
  });

  test("two components with the same block and role but different issueIds are allowed", () => {
    expect(() => parseComponents(JSON.stringify([s3("docs", "163"), s3("docs", "170")]))).not.toThrow();
  });

  test("a role with a hyphen is refused by the spec, not only by the name composer", () => {
    const raw = JSON.stringify([s3("user-d", "1")]);
    expect(() => parseComponents(raw)).toThrow(/no hyphens/);
  });

  test("an empty component list is refused", () => {
    expect(() => parseComponents("[]")).toThrow(/at least one component/);
    expect(() => parseComponents(undefined)).toThrow(/components is required/);
  });

  test("an unknown key in a component is refused", () => {
    const raw = JSON.stringify([{ ...s3("docs", "163"), instance: "01" }]);
    expect(() => parseComponents(raw)).toThrow(/components is not a valid component list/);
  });

  test("malformed JSON says what it received", () => {
    expect(() => parseComponents("not json")).toThrow(/components is not valid JSON.*Received: not json/s);
  });
});
