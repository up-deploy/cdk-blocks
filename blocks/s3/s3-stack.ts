import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
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
    // Shape-checked, not just typed: fromBucketName() validates nothing at synth,
    // so without this an empty string or an illegal name satisfied the "logging is
    // mandatory" gate while configuring a destination that can never work.
    logBucket: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
        "must be a valid S3 bucket name (lowercase, 3-63 chars)",
      )
      .optional(),
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

    // The block composes the name, so the block owns its legality. S3 names are
    // global and CloudFormation only fails at deploy time; catching it here turns
    // a late runtime error into an immediate synth error that names the input.
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) {
      throw new Error(
        `Composed bucket name '${bucketName}' is not a legal S3 name ` +
          `(lowercase alphanumerics and hyphens, 3-63 chars). ` +
          `Check appId, companyId and environment.`,
      );
    }

    const logBucket = props.cfg.logBucket
      ? s3.Bucket.fromBucketName(this, "LogBucket", props.cfg.logBucket)
      : undefined;

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      // One central log bucket serves every block instance, so each writes under
      // its own name — without a prefix the destination is unnavigable.
      serverAccessLogsPrefix: logBucket ? `${bucketName}/` : undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // ACLs stay disabled. This is the modern S3 default, but policy is only
      // policy when the block states it — a default is a suggestion.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Overwrite/delete protection. AwsSolutions has no versioning rule, so
      // this is fenced here and asserted in the POLICY tests instead.
      versioned: true,
      lifecycleRules: [
        {
          // Abandoned multipart uploads are invisible in the console and are
          // billed forever; versioning without noncurrent expiry grows without
          // bound. Both are cost fences, not data policy — current objects are
          // never expired here.
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
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
