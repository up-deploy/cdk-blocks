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
    components: [s3("docs"), s3("upload"), s3("arch")],
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
      "up-s3-a231-upload-dev",
      "up-s3-a231-arch-dev",
    ]) {
      template.hasResourceProperties("AWS::S3::Bucket", { BucketName: name });
    }
  });

  // POLICY: outputs are scoped per component. Two buckets both claiming `BucketName` would
  // leave the second silently overwriting the first.
  test("POLICY: outputs are unique per component", () => {
    for (const id of ["S3DocsBucketName", "S3UploadBucketName", "S3ArchBucketName"]) {
      template.hasOutput(id, {});
    }
  });

  // POLICY: the composed name is emitted so the PLATFORM can read it rather than recompute it.
  test.each([
    ["S3DocsResourceName", "up-s3-a231-docs-dev"],
    ["S3UploadResourceName", "up-s3-a231-upload-dev"],
    ["S3ArchResourceName", "up-s3-a231-arch-dev"],
  ])("POLICY: %s carries the composed name for the platform to read", (id, name) => {
    template.hasOutput(id, { Value: name });
  });

  test("each bucket carries its own role tag", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-a231-upload-dev",
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
          components: [{ block: "dynamodb", role: "sess", blockRef: "v0.3.0" }],
        }),
    ).toThrow(/Unknown block 'dynamodb'.*builds: s3/s);
  });

  // POLICY: (block, role-or-empty) guarantees a unique resource name.
  test("POLICY: two components with the same block and role are refused", () => {
    const raw = JSON.stringify([s3("docs"), s3("docs")]);
    expect(() => parseComponents(raw)).toThrow(/Duplicate component 's3\/docs'/);
  });

  test("two bare components of the same block are refused", () => {
    const bare = { block: "s3", blockRef: "v0.3.0" };
    expect(() => parseComponents(JSON.stringify([bare, bare]))).toThrow(
      /Duplicate component 's3\/'/,
    );
  });

  test("one bare and one roled component of the same block are allowed", () => {
    const bare = { block: "s3", blockRef: "v0.3.0" };
    expect(() => parseComponents(JSON.stringify([bare, s3("docs")]))).not.toThrow();
  });

  test("two components with the same block but different roles are allowed", () => {
    expect(() => parseComponents(JSON.stringify([s3("docs"), s3("upload")]))).not.toThrow();
  });

  test("a role with a hyphen is refused by the spec, not only by the name composer", () => {
    const raw = JSON.stringify([s3("user-d")]);
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

  // The field was dropped in v0.9.0. A stale platform still sending it must fail here,
  // loudly, rather than synthesize a name that drops a segment the requester expects.
  test("a legacy issueId key is refused as unknown", () => {
    const raw = JSON.stringify([{ ...s3("docs"), issueId: "163" }]);
    expect(() => parseComponents(raw)).toThrow(/components is not a valid component list/);
  });

  test("malformed JSON says what it received", () => {
    expect(() => parseComponents("not json")).toThrow(/components is not valid JSON.*Received: not json/s);
  });
});
