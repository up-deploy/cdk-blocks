# Block: static-website

Static website hosting on S3 — **dev/testing profile**: S3 website endpoint only, no CloudFront. Fast to deploy, trivial to destroy; the website endpoint is HTTP and publicly readable by design. A CloudFront/HTTPS variant is the planned `stable` upgrade of this block.

| | |
|---|---|
| **Entry** | `bin/static-website.ts` |
| **Inputs** | `instance` (required, `^[a-z][a-z0-9-]{2,20}$`), `env` (default `dev`) |
| **Outputs** | `WebsiteUrl` — S3 website endpoint (HTTP) · `BucketName` — upload target for site content |
| **Cost** | ~0€ idle — S3 pay-per-use, no standing resources |
| **Destroy** | Clean — bucket contents auto-deleted, nothing orphaned |

## Resources

- S3 bucket: website hosting (`index.html` / `error.html`), public read via bucket policy (ACLs stay blocked), S3-managed encryption

## Deploy (what the platform runs)

```bash
npx cdk deploy -a "npx ts-node bin/static-website.ts" -c instance=demo -c env=dev
```
