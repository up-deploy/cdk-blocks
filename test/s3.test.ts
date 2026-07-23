import { App, AspectPriority, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { S3BucketStack, S3Config, S3_CONFIG_KEYS } from "../blocks/s3/s3-stack";
import { parseBlockConfig } from "../lib/block-config";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";
import { AwsSolutionsChecks } from "cdk-nag";


describe("s3 block (private, secure-by-default bucket)", () => {
  const app = new App();
  const stack = new S3BucketStack(app, "up-s3-test-dev", {
    environment: "dev",
    appId: "0asd3",
    companyId: "up",
    cfg: {}
  });
  const template = Template.fromStack(stack);

  test("bucket blocks all public access", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("bucket policy enforces SSL-only access", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:*",
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  test("bucket is encrypted", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  test("no website hosting, no public content", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    for (const b of Object.values(buckets)) {
      expect(b.Properties?.WebsiteConfiguration).toBeUndefined();
    }
  });

  test("declares the outputs the catalog promises", () => {
    template.hasOutput("BucketName", {});
    template.hasOutput("BucketArn", {});
  });

  test("the block composes the bucket name, the caller only supplies appId", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "up-s3-0asd3-dev-01",
    });
  });

  // POLICY: retain is class-2 config, so prod and dev run the SAME block code and differ only in
  // the value they are handed. These two assertions are that difference.
  test("retain: false gives DeletionPolicy Delete", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
  });

  test("retain: true gives DeletionPolicy Retain, from the same block", () => {
    const prodApp = new App();
    const prodStack = new S3BucketStack(prodApp, "up-s3-test-prod", {
      environment: "prod",
      appId: "0asd3",
      companyId: "up",
      cfg: { retain: true },
    });

    Template.fromStack(prodStack).hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
    });
  });
});

describe("platform tags (docs/tagging-schema.md)", () => {
  const PLATFORM_TAGS = [
    { Key: "up:app-id", Value: "0asd3" },
    { Key: "up:block", Value: "s3" },
    { Key: "up:block-ref", Value: "v0.1.0" },
    { Key: "up:env", Value: "dev" },
    { Key: "up:managed", Value: "true" },
  ];

  function tagged(extra?: Record<string, unknown>) {
    const app = new App();
    const stack = new S3BucketStack(app, "up-s3-test-dev", {
      environment: "dev",
      appId: "0asd3",
      companyId: "up",
      cfg: {},
    });
    applyPlatformTags(app, {
      companyId: "up",
      appId: "0asd3",
      environment: "dev",
      block: "s3",
      blockRef: "v0.1.0",
      extra,
    });
    return { app, stack };
  }

  test("every platform key lands on the bucket, namespaced with companyId", () => {
    const { stack } = tagged();
    Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith(PLATFORM_TAGS),
    });
  });

  test("config keys are prefixed by the block, not supplied prefixed", () => {
    const { stack } = tagged({ "cost-center": "platform", owner: "upstood" });
    Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([
        { Key: "up:cost-center", Value: "platform" },
        { Key: "up:owner", Value: "upstood" },
      ]),
    });
  });

  // A config key that shadowed app-id would replace the only class-1 value in the schema with a
  // per-environment constant. Tags.of is last-write-wins, so this would fail silently.
  test.each(["app-id", "env", "block", "block-ref", "managed", "companyid"])(
    "rejects the reserved key '%s'",
    (key) => {
      expect(() => tagged({ [key]: "x" })).toThrow(/Reserved tag key/);
    },
  );

  test.each(["Cost_Center", "costCenter", "aws:foo", "up:owner", "9lives", ""])(
    "rejects the malformed key '%s'",
    (key) => {
      expect(() => tagged({ [key]: "x" })).toThrow(/Invalid tag key/);
    },
  );

  test("RequiredTagsAspect reports an error when a required tag is missing", () => {
    const app = new App();
    const stack = new S3BucketStack(app, "up-s3-untagged-dev", {
      environment: "dev",
      appId: "0asd3",
      companyId: "up",
      cfg: {},
    });
    // No applyPlatformTags call — this is the hole the aspect exists to catch.
    Aspects.of(app).add(new RequiredTagsAspect("up"), {
      priority: AspectPriority.READONLY,
    });

    Annotations.fromStack(stack).hasError(
      "*",
      Match.stringLikeRegexp("Missing required tag.*up:managed"),
    );
  });

  test("the aspect is silent once the tags are applied", () => {
    const { stack } = tagged();
    Aspects.of(stack.node.root).add(new RequiredTagsAspect("up"), {
      priority: AspectPriority.READONLY,
    });

    expect(
      Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("Missing required tag")),
    ).toHaveLength(0);
  });
});



describe("compliance gate (cdk-nag AwsSolutions)", () => {
  test("POLICY: the s3 block has no AwsSolutions violations", () => {
    const app = new App();
    const stack = new S3BucketStack(app, "S3", {
      env: { account: "012514678082", region: "eu-west-1" },
      companyId: "up",
      appId: "a231",
      environment: "dev",
      cfg: {},
    });

    const report = new AwsSolutionsChecks(app).validateScope(stack);

    expect(
      report.violations.map((v) => `${v.ruleName}: ${v.description}`)
    ).toEqual([]);  });
});


describe("blockConfig validation (lib/block-config.ts)", () => {
  // Class-2 config reaches the block as one JSON string, and until 2026-07-23 an
  // unrecognised key was silently dropped: `{"retian":true}` synthesized a bucket
  // with DeletionPolicy: Delete and exited 0, while the environment file said the
  // bucket should be retained. In prod that is data loss from a transposed letter.
  const parse = (raw: string | undefined) =>
    parseBlockConfig<S3Config>(raw, S3_CONFIG_KEYS, "s3");

  test("POLICY: a misspelled key is rejected, not ignored", () => {
    expect(() => parse('{"retian":true}')).toThrow(/Unknown blockConfig key\(s\).*retian/);
  });

  test("the error names what the block does accept", () => {
    expect(() => parse('{"retian":true}')).toThrow(/accepts: retain/);
  });

  test("every unknown key is reported, not just the first", () => {
    expect(() => parse('{"retian":true,"versionned":true}')).toThrow(/retian, versionned/);
  });

  test("a declared key is accepted and keeps its real boolean type", () => {
    expect(parse('{"retain":false}')).toEqual({ retain: false });
  });

  test("absent config is an empty object, not an error", () => {
    expect(parse(undefined)).toEqual({});
  });

  test("malformed JSON reports the raw value it was given", () => {
    expect(() => parse("{not json")).toThrow(/is not valid JSON.*Received: \{not json/s);
  });

  // typeof null === "object" and an array is an object too, so both would pass a
  // naive check and then read as empty config — the silent failure all over again.
  test.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"retain"'],
    ["a number", "7"],
  ])("JSON %s is rejected", (_label, raw) => {
    expect(() => parse(raw)).toThrow(/must be a JSON object/);
  });
});
