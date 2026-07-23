import { App, AspectPriority, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { S3BucketStack, S3ConfigSchema } from "../blocks/s3/s3-stack";
import { parseBlockConfig } from "../lib/block-config";
import { applyPlatformTags, parseExtraTags, RequiredTagsAspect } from "../lib/platform-tags";
import { AwsSolutionsChecks } from "cdk-nag";


describe("s3 block (private, secure-by-default bucket)", () => {
  const app = new App();
  const stack = new S3BucketStack(app, "up-s3-test-dev", {
    environment: "dev",
    appId: "0asd3",
    companyId: "up",
    cfg: {logBucket: "somelogbuckeg"}
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

  // POLICY: versioning is class-3 — overwrite/delete protection is not a choice the
  // environment file gets to make. AwsSolutions has no versioning rule, so this test
  // is the only fence.
  test("POLICY: bucket is versioned", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  // POLICY: ACLs stay disabled. BucketOwnerEnforced is the modern S3 default, but a
  // default is a suggestion — stating it is what makes it policy.
  test("POLICY: object ownership is BucketOwnerEnforced (ACLs disabled)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      },
    });
  });

  // Cost fences, not data policy: current objects are never expired.
  test("lifecycle aborts stale multipart uploads and expires noncurrent versions", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            Status: "Enabled",
          }),
        ]),
      },
    });
  });

  // One central log bucket serves every block instance; without a per-bucket prefix
  // the destination is one interleaved stream.
  test("access logs are prefixed with the bucket's own name", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LoggingConfiguration: Match.objectLike({
        LogFilePrefix: "up-s3-0asd3-dev-01/",
      }),
    });
  });

  // The block composes the name, so the block owns its legality. S3 caps names at
  // 63 chars and CloudFormation only notices at deploy time.
  test("a composed name over 63 characters fails at synth, not at deploy", () => {
    const longApp = new App();
    expect(
      () =>
        new S3BucketStack(longApp, "up-s3-too-long", {
          environment: "dev",
          appId: "a".repeat(60),
          companyId: "up",
          cfg: {},
        }),
    ).toThrow(/not a legal S3 name/);
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

  // AWS caps tag values at 256 chars and rejects the write at DEPLOY time; an
  // empty value is a key that tags nothing. Both must die at synth instead.
  test("rejects an empty tag value", () => {
    expect(() => tagged({ owner: "" })).toThrow(/Invalid value for tag key 'owner'/);
  });

  test("rejects a tag value over 256 characters", () => {
    expect(() => tagged({ owner: "x".repeat(257) })).toThrow(/1-256 characters/);
  });

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
      // logging is mandatory now (the S1 acknowledgement was removed), so a compliant
      // bucket MUST have a destination — an empty cfg would legitimately fail S1.
      cfg: { logBucket: "up-s3-logs-dev-01" },
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
    parseBlockConfig(raw, S3ConfigSchema, "s3");

  test("POLICY: a misspelled key is rejected, not ignored", () => {
    // `.strict()` — the whole reason a schema replaced the old key array.
    expect(() => parse('{"retian":true}')).toThrow(/[Uu]nrecognized key.*retian/);
  });

  test("every unknown key is reported, not just the first", () => {
    expect(() => parse('{"retian":true,"versionned":true}')).toThrow(/retian[\s\S]*versionned/);
  });

  test("POLICY: a wrong value type is rejected, not coerced", () => {
    // `-c retain=false` gives the STRING "false", which is truthy — the D-002 bug.
    // The old key-only check missed this; the schema's z.boolean() catches it.
    expect(() => parse('{"retain":"false"}')).toThrow(/retain.*[Ee]xpected boolean/);
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
    expect(() => parse(raw)).toThrow(/[Ee]xpected object/);
  });

  // fromBucketName() validates nothing at synth, so before the shape check an empty
  // string or an illegal name satisfied "logging is configured" while pointing at a
  // destination that can never receive a log line.
  test("POLICY: an empty logBucket is rejected, not treated as configured", () => {
    expect(() => parse('{"logBucket":""}')).toThrow(/valid S3 bucket name/);
  });

  test("a logBucket that is not a legal S3 name is rejected", () => {
    expect(() => parse('{"logBucket":"Not_A_Bucket"}')).toThrow(/valid S3 bucket name/);
  });

  test("a legal logBucket name is accepted", () => {
    expect(parse('{"logBucket":"up-s3-logs-dev-01"}')).toEqual({
      logBucket: "up-s3-logs-dev-01",
    });
  });
});


describe("tags context parsing (lib/platform-tags.ts)", () => {
  // The `-c tags` blob travels through yq, GITHUB_OUTPUT and a workflow input
  // before it reaches the block. A bare JSON.parse threw a SyntaxError naming
  // nothing about where the value came from — inconsistent with parseBlockConfig,
  // which this now mirrors.
  test("absent tags are an empty object, not an error", () => {
    expect(parseExtraTags(undefined)).toEqual({});
  });

  test("a valid object parses", () => {
    expect(parseExtraTags('{"owner":"upstood"}')).toEqual({ owner: "upstood" });
  });

  test("malformed JSON reports the raw value it was given", () => {
    expect(() => parseExtraTags("{not json")).toThrow(/not valid JSON.*Received: \{not json/s);
  });

  test.each([
    ["null", "null"],
    ["an array", '["owner"]'],
    ["a string", '"owner"'],
  ])("JSON %s is rejected", (_label, raw) => {
    expect(() => parseExtraTags(raw)).toThrow(/must be a JSON object/);
  });
});
