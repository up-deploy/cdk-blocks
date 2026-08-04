import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { composeResourceName } from "../lib/naming";
import { AppStack } from "../app/app-stack";

describe("resource naming (lib/naming.ts)", () => {
  const base = {
    companyId: "up",
    block: "s3",
    appId: "a231",
    role: "docs",
    environment: "dev",
    issueId: "163",
  };

  test("composes <companyId>-<block>-<appId>-<role>-<env>-<issueId>", () => {
    expect(composeResourceName(base)).toBe("up-s3-a231-docs-dev-163");
  });

  test("omits the role segment when role is absent", () => {
    const { role: _r, ...noRole } = base;
    expect(composeResourceName(noRole)).toBe("up-s3-a231-dev-163");
  });

  // POLICY: issueId is what makes two same-block components distinct when role is shared or absent.
  test("POLICY: a different issueId is what makes a different name", () => {
    expect(composeResourceName({ ...base, issueId: "170" })).toBe("up-s3-a231-docs-dev-170");
  });

  // POLICY: optional role is a readability segment, not a counter. issueId is always present.
  test("POLICY: the name always ends with the issueId", () => {
    expect(composeResourceName(base).split("-").at(-1)).toBe("163");
    expect(composeResourceName({ ...base, role: undefined }).split("-").at(-1)).toBe("163");
  });

  // POLICY: the segments stay visually distinct. A hyphen inside a role would read as a
  // segment boundary to every human looking at the console.
  test("POLICY: a role containing a hyphen is refused", () => {
    expect(() => composeResourceName({ ...base, role: "user-d" })).toThrow(/Invalid role/);
  });

  test("an uppercase or too-long role is refused", () => {
    expect(() => composeResourceName({ ...base, role: "Docs" })).toThrow(/Invalid role/);
    expect(() => composeResourceName({ ...base, role: "toolong" })).toThrow(/Invalid role/);
  });

  test("a malformed issueId is refused", () => {
    expect(() => composeResourceName({ ...base, issueId: "0163" })).toThrow(/Invalid issueId/);
    expect(() => composeResourceName({ ...base, issueId: "0" })).toThrow(/Invalid issueId/);
  });
});

describe("role as a tag, not only a name segment", () => {
  const app = new App();
  const stack = new AppStack(app, "up-a231-dev", {
    companyId: "up",
    appId: "a231",
    environment: "dev",
    components: [
      {
        block: "s3",
        role: "docs",
        issueId: "163",
        blockRef: "v0.3.0",
        config: { logBucket: "up-s3-logs-dev-01" },
      },
    ],
  });
  const template = Template.fromStack(stack);

  // POLICY: the name is for humans, the tag is what Cost Explorer and AWS Config can filter on.
  // One assertion per key, deliberately. Match.arrayWith matches a SUBSEQUENCE, so listing
  // several keys at once silently couples the test to the order CDK happens to render tags in.
  test.each([
    ["up:role", "docs"],
    ["up:block", "s3"],
    ["up:block-ref", "v0.3.0"],
    ["up:issue-id", "163"],
  ])("POLICY: the component emits %s itself", (Key, Value) => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([{ Key, Value }]),
    });
  });

  // The caller never applied any tags here — the construct did it in its own constructor,
  // so a component added to an app stack cannot arrive unlabelled.
  test("POLICY: component tags do not depend on the caller remembering", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-a231-docs-dev-163",
    });
  });
});
