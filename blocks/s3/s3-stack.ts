import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { z } from "zod";

/**
 * What `blockConfig` accepts for this block — the SINGLE definition. `.strict()` rejects
 * unknown keys (a typo'd `retian` fails instead of being silently ignored), each field
 * fixes its type (so `retain: "false"` is rejected too), and `S3Config` is INFERRED from
 * it — no second list to keep in sync. Adding a parameter is one line here.
 */
export const S3ConfigSchema = z
  .object({
    retain: z.boolean().optional(),
    logBucket: z.string().optional(),
  })
  .strict();

export type S3Config = z.infer<typeof S3ConfigSchema>;


export interface S3BucketStackProps extends StackProps {
  readonly appId: string
  readonly environment: string
  readonly companyId: string
  readonly cfg: S3Config
}



export class S3BucketStack extends Stack {
  public readonly bucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: S3BucketStackProps) {
    super(scope, id, props);

    const bucketName = props.companyId + "-s3-" + props.appId + "-" + props.environment + "-01"

    const logBucket = props.cfg.logBucket
      ? s3.Bucket.fromBucketName(this, "LogBucket", props.cfg.logBucket)
      : undefined;

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: props.cfg.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
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
