import { Annotations, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { z } from "zod";
import { composeResourceName } from "../../lib/naming";
import { applyComponentTags } from "../../lib/platform-tags";

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

export interface S3BucketProps {
  readonly appId: string;
  readonly environment: string;
  readonly companyId: string;
  /** What this bucket is for, e.g. `docs`. Name segment, tag, and the whole discriminator. */
  readonly role: string;
  /** Which version of this block built the resource. Component-tier tag. */
  readonly blockRef: string;
  readonly cfg: S3Config;
}

/**
 * A block is a CONSTRUCT, not a stack. One stack belongs to one app team and holds every
 * component that team has asked for, so the stack identity cannot belong to any single block.
 * The policy fence, the name composition and the outputs travel with the construct.
 */
export class S3Bucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3BucketProps) {
    super(scope, id);

    // The component tags itself. An app stack composes several of these, and a component that
    // relied on its caller to say which block built it would eventually meet a caller that forgot.
    applyComponentTags(this, {
      companyId: props.companyId,
      block: "s3",
      blockRef: props.blockRef,
      role: props.role,
    });

    // The platform's naming guarantee lives in lib/naming.ts, so `role` is validated once for
    // every block rather than re-checked here.
    const bucketName = composeResourceName({
      companyId: props.companyId,
      block: "s3",
      appId: props.appId,
      role: props.role,
      environment: props.environment,
    });

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

    if (logBucket) {
      // An imported destination is not a construct CDK can attach a policy to, so it warns
      // `@aws-cdk/aws-s3:accessLogsPolicyNotAdded` and declines to grant
      // `logging.s3.amazonaws.com` PutObject on it. That warning is PERMANENT, not a symptom
      // of the current placeholder name: every legal value still arrives through
      // fromBucketName(), so a real log bucket would not clear it.
      //
      // Acknowledged on THIS construct rather than in app/app.ts, so the claim is scoped to
      // one component — this block cannot grant on an imported destination — instead of
      // silencing the id for every component an app team ever composes.
      //
      // The destination's policy is owned OUTSIDE the block: by hand today, by the
      // environment baseline (C3) later. It has to be, because a logging destination must not
      // have access logging enabled on itself, and this block makes logging mandatory — so
      // the platform's own rule leaves it structurally unable to create its own precondition.
      //
      // This is NOT the deal cdk-nag offers. acknowledgeWarning() accepts a message and
      // DISCARDS it, then splices the entry out of the assembly: nothing reaches template
      // Metadata, and nothing is readable from AWS with GetTemplate, where a cdk-nag
      // acknowledgement writes both its id and its reason. These comment lines are the only
      // record of this exception that exists anywhere. The message is passed regardless, so
      // the intent sits at the call site and not only above it.
      Annotations.of(this).acknowledgeWarning(
        "@aws-cdk/aws-s3:accessLogsPolicyNotAdded",
        `Access-log destination '${props.cfg.logBucket}' is imported by name, so this block ` +
          `cannot attach its bucket policy. The destination and its policy are owned by the ` +
          `environment, not by the app.`,
      );
    }

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,

      serverAccessLogsPrefix: logBucket ? `${bucketName}/` : undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,

      versioned: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
      removalPolicy: props.cfg.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
