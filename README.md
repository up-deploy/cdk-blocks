# cdk-blocks

CDK building blocks for [up-platform](https://github.com/updeploy/up-platform) — one deployable infrastructure block per entry, consumed **at pinned tags**.

## How consumption works

This repo is never installed as a package. The platform's deploy workflow checks out this repo at the exact tag recorded in the platform catalog (`source.ref`) and deploys one entry:

```bash
npx cdk deploy -a "npx ts-node bin/<block>.ts" -c instance=<name> -c env=<ring>
```

A new tag here changes nothing on the platform until a catalog PR in `up-platform` moves the pin.

## Blocks

| Block | Entry | What it deploys |
|-------|-------|-----------------|
| [`static-website`](blocks/static-website/) | `bin/static-website.ts` | Private S3 bucket + CloudFront (OAC), SSL-enforced |

## The block contract

Every block in this repo must:

1. **Name predictably** — stack name `upp-<block>-<instance>-<env>`
2. **Tag everything** — `company`, `appId`, `environment`, `owner`, plus `upp:component` and `upp:instance` (applied in the `bin/` entry)
3. **Validate its inputs** — the entry rejects bad context values before synth
4. **Declare its outputs** — `CfnOutput`s matching the catalog manifest's `outputs` list (they become the issue comment after deploy)
5. **Destroy cleanly** — `cdk destroy` leaves nothing behind (e.g. buckets auto-delete their contents)
6. **Prove itself** — unit tests with `Template` assertions; `npm test` green before any PR

## Local development

```bash
npm install
npm test
npm run synth:static-website -- -c instance=demo -c env=dev   # full synth, no AWS credentials needed
```

## Releasing

Merge to `main` via PR, then tag: `git tag v0.x.y && git push origin v0.x.y`. The platform adopts the release only when its catalog pin is updated (see [the catalog](https://github.com/updeploy/up-platform/tree/main/catalog)).
