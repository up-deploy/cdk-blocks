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
  };

  test("composes <companyId>-<block>-<appId>-<role>-<env>", () => {
    expect(composeResourceName(base)).toBe("up-s3-a231-docs-dev");
  });

  // POLICY: `role` is the ONLY thing distinguishing two components of the same block inside one
  // app's stack. There is no counter behind it, so two components serving the same purpose is a
  // naming problem the requester fixes, not one the platform numbers around.
  test("POLICY: a different role is what makes a different name", () => {
    expect(composeResourceName({ ...base, role: "uploads" })).toBe("up-s3-a231-uploads-dev");
  });

  // POLICY: the name is a PURE FUNCTION of facts the request already carries. It can be predicted
  // before the request is made and never depends on what else the app happens to contain. Five
  // segments, no sixth: this goes red the day someone reintroduces a derived counter.
  test("POLICY: the name carries no sequence segment", () => {
    expect(composeResourceName(base).split("-")).toHaveLength(5);
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
});

describe("role as a tag, not only a name segment", () => {
  const app = new App();
  const stack = new AppStack(app, "up-a231-dev", {
    companyId: "up",
    appId: "a231",
    environment: "dev",
    components: [{ block: "s3", role: "docs", blockRef: "v0.3.0", config: { logBucket: "up-s3-logs-dev-01" } }],
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
      BucketName: "up-s3-a231-docs-dev",
    });
  });
});
