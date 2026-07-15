import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { S3BucketStack } from "../blocks/s3/s3-stack";

describe("s3 block (private, secure-by-default bucket)", () => {
  const app = new App();
  const stack = new S3BucketStack(app, "upp-s3-test-dev", {
    instance: "test",
    environment: "dev",
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
});
