import { App, AspectPriority, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { S3BucketStack } from "../blocks/s3/s3-stack";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";

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
