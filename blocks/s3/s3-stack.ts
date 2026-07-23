import { CfnOutput, RemovalPolicy, Stack, StackProps, Validations } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface S3BucketStackProps extends StackProps {
  readonly appId: string
  readonly environment: string
  readonly companyId: string
  cfg: {
    readonly retain?:boolean
  }
}



export class S3BucketStack extends Stack {
  public readonly bucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: S3BucketStackProps) {
    super(scope, id, props);

    const bucketName = props.companyId + "-s3-" + props.appId + "-" + props.environment + "-01"

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: props.cfg.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Class-3 exception, not a config option. Acknowledged on the bucket rather than the
    // stack so a future resource added here does not silently inherit the exemption.
    Validations.of(this.bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "No log destination exists until the central logging bucket lands in "
            + "roadmap B1. The bucket is private, SSL-only and encrypted. Revisit when B1 ships.",
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
