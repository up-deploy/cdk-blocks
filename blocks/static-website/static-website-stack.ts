import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface StaticWebsiteStackProps extends StackProps {
  /** Instance name; part of every resource name and tag. */
  readonly instance: string;
  /** Environment ring (dev, prod). */
  readonly environment: string;
}

/**
 * Block: static-website
 * S3 bucket (private, SSL-enforced) served through CloudFront with
 * Origin Access Control. Destroys cleanly: bucket contents are
 * auto-deleted so `cdk destroy` leaves nothing behind.
 */
export class StaticWebsiteStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StaticWebsiteStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `up-platform static-website (${props.instance}, ${props.environment})`,
    });

    new CfnOutput(this, "WebsiteUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description: "Public URL of the website",
    });
    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "Bucket to upload site content to",
    });
  }
}
