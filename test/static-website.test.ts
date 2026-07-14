import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { StaticWebsiteStack } from "../blocks/static-website/static-website-stack";

describe("static-website block (dev/testing profile: S3 website hosting, no CloudFront)", () => {
  const app = new App();
  const stack = new StaticWebsiteStack(app, "upp-static-website-test-dev", {
    instance: "test",
    environment: "dev",
  });
  const template = Template.fromStack(stack);

  test("bucket has website hosting enabled", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      WebsiteConfiguration: {
        IndexDocument: "index.html",
        ErrorDocument: "error.html",
      },
    });
  });

  test("content is publicly readable via bucket policy (website endpoint)", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Effect: "Allow",
            Principal: { AWS: "*" },
          }),
        ]),
      },
    });
  });

  test("no CloudFront in the dev/testing profile", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  test("declares the outputs the catalog promises", () => {
    template.hasOutput("WebsiteUrl", {});
    template.hasOutput("BucketName", {});
  });
});
