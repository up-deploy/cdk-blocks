# Block: s3

A private, secure-by-default S3 bucket. Nothing else — no website hosting, no public access. Use cases (static sites, data buckets, artifact storage) are built *on top of* this primitive, or arrive later as composed blocks.

| | |
|---|---|
| **Entry** | `bin/s3.ts` |
| **Inputs** | `instance` (required, `^[a-z][a-z0-9-]{2,20}$`), `env` (default `dev`) |
| **Outputs** | `BucketName` · `BucketArn` |
| **Cost** | ~0€ idle — S3 pay-per-use, no standing resources |
| **Destroy** | Clean — bucket contents auto-deleted, nothing orphaned |

## Fixed policy (not user-changeable)

- All public access blocked
- SSL-only access (bucket policy denies non-TLS requests)
- Encryption at rest (S3-managed in the dev profile; the KMS variant reads the environment key from `/upp/platform/<env>/kms-key-arn`)
- Clean teardown (objects auto-deleted on destroy)

## Deploy (what the platform runs)

```bash
npx cdk deploy -a "npx ts-node bin/s3.ts" -c instance=demo -c env=dev
```
