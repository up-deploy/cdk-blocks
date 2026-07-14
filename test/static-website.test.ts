import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { StaticWebsiteStack } from "../blocks/static-website/static-website-stack";

describe("static-website block", () => {
  const app = new App();
  const stack = new StaticWebsiteStack(app, "upp-static-website-test-dev", {
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

  test("bucket policy enforces SSL", () => {
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

  test("serves through CloudFront with Origin Access Control", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: { ViewerProtocolPolicy: "redirect-to-https" },
      },
    });
  });

  test("declares the outputs the catalog promises", () => {
    template.hasOutput("WebsiteUrl", {});
    template.hasOutput("BucketName", {});
  });
});
