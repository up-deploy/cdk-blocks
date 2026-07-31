import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { composeResourceName, DEFAULT_SEQ } from "../lib/naming";
import { S3BucketStack } from "../blocks/s3/s3-stack";

describe("resource naming (lib/naming.ts)", () => {
  const base = {
    companyId: "up",
    block: "s3",
    appId: "a231",
    role: "docs",
    environment: "dev",
  };

  test("composes <companyId>-<block>-<appId>-<role>-<env>-<seq>", () => {
    expect(composeResourceName({ ...base, seq: "01" })).toBe("up-s3-a231-docs-dev-01");
  });

  test("seq defaults to 01", () => {
    expect(composeResourceName(base)).toBe(`up-s3-a231-docs-dev-${DEFAULT_SEQ}`);
    expect(DEFAULT_SEQ).toBe("01");
  });

  test("a second component with the same role is 02", () => {
    expect(composeResourceName({ ...base, seq: "02" })).toBe("up-s3-a231-docs-dev-02");
  });

  // POLICY: a different role restarts the sequence, so the pair (role, seq) is what
  // distinguishes two components of the same block inside one app's stack.
  test("POLICY: a different role starts again at 01", () => {
    expect(composeResourceName({ ...base, role: "uploads" })).toBe("up-s3-a231-uploads-dev-01");
  });

  // POLICY: the segments stay visually distinct. A hyphen inside a role would read as a
  // segment boundary to every human looking at the console.
  test("POLICY: a role containing a hyphen is refused", () => {
    expect(() => composeResourceName({ ...base, role: "user-docs" })).toThrow(/Invalid role/);
  });

  test("an uppercase or too-short role is refused", () => {
    expect(() => composeResourceName({ ...base, role: "Docs" })).toThrow(/Invalid role/);
    expect(() => composeResourceName({ ...base, role: "d" })).toThrow(/Invalid role/);
  });

  // POLICY: seq is supplied, never derived from position. A single digit is refused so that
  // `1` and `01` cannot both exist and name two different resources.
  test("POLICY: seq must be exactly two digits", () => {
    expect(() => composeResourceName({ ...base, seq: "1" })).toThrow(/Invalid seq/);
    expect(() => composeResourceName({ ...base, seq: "001" })).toThrow(/Invalid seq/);
  });
});

describe("role as a tag, not only a name segment", () => {
  const app = new App();
  const stack = new S3BucketStack(app, "up-a231-dev", {
    companyId: "up",
    appId: "a231",
    environment: "dev",
    role: "docs",
    blockRef: "v0.3.0",
    cfg: { logBucket: "up-s3-logs-dev-01" },
  });
  const template = Template.fromStack(stack);

  // POLICY: the name is for humans, the tag is what Cost Explorer and AWS Config can filter on.
  // One assertion per key, deliberately. Match.arrayWith matches a SUBSEQUENCE, so listing
  // several keys at once silently couples the test to the order CDK happens to render tags in.
  test.each([
    ["up:role", "docs"],
    ["up:block", "s3"],
    ["up:block-ref", "v0.3.0"],
  ])("POLICY: the component emits %s itself", (Key, Value) => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([{ Key, Value }]),
    });
  });

  // The caller never applied any tags here — the construct did it in its own constructor,
  // so a component added to an app stack cannot arrive unlabelled.
  test("POLICY: component tags do not depend on the caller remembering", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-a231-docs-dev-01",
    });
  });
});
