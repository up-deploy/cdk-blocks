# Block: static-website

Static website hosting: private S3 bucket served through CloudFront with Origin Access Control. HTTPS enforced end to end.

| | |
|---|---|
| **Entry** | `bin/static-website.ts` |
| **Inputs** | `instance` (required, `^[a-z][a-z0-9-]{2,20}$`), `env` (default `dev`) |
| **Outputs** | `WebsiteUrl` — public URL · `BucketName` — upload target for site content |
| **Cost** | ~0€ idle — S3 + CloudFront are pay-per-use, no standing resources |
| **Destroy** | Clean — bucket contents auto-deleted, nothing orphaned |

## Resources

- S3 bucket: all public access blocked, S3-managed encryption, SSL-only bucket policy
- CloudFront distribution: OAC to the bucket, redirect-to-HTTPS, PriceClass 100 (EU/NA edges)

## Deploy (what the platform runs)

```bash
npx cdk deploy -a "npx ts-node bin/static-website.ts" -c instance=demo -c env=dev
```
