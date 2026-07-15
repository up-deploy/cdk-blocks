import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface S3BucketStackProps extends StackProps {
  /** Instance name; part of every resource name and tag. */
  readonly instance: string;
  /** Environment ring (dev, prod). */
  readonly environment: string;
}

/**
 * Block: s3
 * A private, secure-by-default S3 bucket. Nothing else.
 *  - all public access blocked
 *  - SSL-only access enforced by bucket policy
 *  - S3-managed encryption (dev profile; a KMS variant will read the
 *    environment key from /upp/platform/<env>/kms-key-arn)
 * Destroys cleanly: contents are auto-deleted so `cdk destroy`
 * leaves nothing behind.
 */
export class S3BucketStack extends Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3BucketStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "Name of the bucket",
    });
    new CfnOutput(this, "BucketArn", {
      value: this.bucket.bucketArn,
      description: "ARN of the bucket",
    });
  }
}
