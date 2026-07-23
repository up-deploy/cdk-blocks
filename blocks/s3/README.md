# Block: s3

A private, secure-by-default S3 bucket. Nothing else — no website hosting, no public access. Use cases (static sites, data buckets, artifact storage) are built *on top of* this primitive, or arrive later as composed blocks.

| | |
|---|---|
| **Entry** | `bin/s3.ts` |
| **Name** | composed by the block: `<companyId>-s3-<appId>-<env>-01` |
| **Inputs (context)** | `account` (12 digits) · `region` · `companyId` · `appId` (`^[a-z0-9]{4}$`) · `env` · `blockRef` · `blockConfig` · `tags` |
| **blockConfig** | `retain` (boolean — `DeletionPolicy: Retain` vs `Delete`) · `logBucket` (S3 bucket name, the access-log destination) |
| **Outputs** | `BucketName` · `BucketArn` |
| **Cost** | ~0€ idle — S3 pay-per-use, no standing resources |
| **Destroy** | `retain: true` keeps the bucket. With `retain: false` the stack deletes the bucket only if it is **empty** — contents are never auto-deleted (that needs a custom-resource Lambda, deliberately not added while the pipeline is synth-only) |

`blockConfig` is validated against `S3ConfigSchema` (zod, `.strict()`): unknown keys, wrong
types, an empty or illegal `logBucket` name — all fail the synth loudly.

## Fixed policy (class 3 — not user-changeable, no override props)

- All public access blocked
- SSL-only access (bucket policy denies non-TLS requests)
- Encryption at rest (S3-managed keys; a KMS option is future work, not built)
- Versioning on (overwrite/delete protection)
- ACLs disabled (`BucketOwnerEnforced` ownership)
- Access logging is **mandatory in practice**: without `logBucket`, cdk-nag's
  `AwsSolutions-S1` fails the synth (the acknowledgement was removed on purpose)
- Cost fences: incomplete multipart uploads aborted after 7 days, noncurrent
  versions expired after 90 days — current objects are never expired

## Synth (what the platform runs)

```bash
npx cdk synth -a "npx ts-node bin/s3.ts" \
  -c account=012514678082 -c region=eu-west-1 -c companyId=up \
  -c appId=a231 -c env=dev -c blockRef=v0.3.0 -c tags='{}' \
  -c blockConfig='{"retain":false,"logBucket":"up-s3-logs-dev-01"}'
```

Nothing deploys yet — the pipeline is synth-only until platform Phase B.
