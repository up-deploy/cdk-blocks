import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { S3Bucket, S3Config } from "./s3-bucket";

// The schema lives with the construct now — it describes the component, not the stack.
// Re-exported so existing importers keep one import path while the app stack lands.
export { S3ConfigSchema, S3Config, S3BucketProps } from "./s3-bucket";

export interface S3BucketStackProps extends StackProps {
  readonly appId: string
  readonly environment: string
  readonly companyId: string
  readonly cfg: S3Config
}

/**
 * TEMPORARY. One stack per block is the shape being replaced: a stack belongs to an app team
 * and holds every component that team asked for. This wrapper exists only so the current
 * pipeline keeps working while the app stack and its manifest are built; it will be deleted,
 * not extended.
 */
export class S3BucketStack extends Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3BucketStackProps) {
    super(scope, id, props);

    this.bucket = new S3Bucket(this, "S3", {
      companyId: props.companyId,
      appId: props.appId,
      environment: props.environment,
      cfg: props.cfg,
    }).bucket;

    // Outputs are declared by the STACK, not by the construct: their logical IDs are the
    // names the catalog promises (`outputs: [BucketName, BucketArn]`) and the router comments
    // back. A construct cannot own them — once one stack holds two buckets, two components
    // would both claim `BucketName`. How the app stack discriminates them is the open question.
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
