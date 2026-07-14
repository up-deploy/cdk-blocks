import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface StaticWebsiteStackProps extends StackProps {
  /** Instance name; part of every resource name and tag. */
  readonly instance: string;
  /** Environment ring (dev, prod). */
  readonly environment: string;
}

/**
 * Block: static-website (dev/testing profile)
 * S3 website hosting only — no CloudFront while we develop and test the
 * platform (faster deploys, simpler teardown). The website endpoint is
 * HTTP and publicly readable by design; a CloudFront/HTTPS variant is
 * the planned `stable` upgrade of this block.
 * Destroys cleanly: bucket contents are auto-deleted.
 */
export class StaticWebsiteStack extends Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StaticWebsiteStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "SiteBucket", {
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "error.html",
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new CfnOutput(this, "WebsiteUrl", {
      value: this.bucket.bucketWebsiteUrl,
      description: "Public URL of the website (S3 website endpoint, HTTP)",
    });
    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "Bucket to upload site content to",
    });
  }
}
