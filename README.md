# cdk-blocks

CDK building blocks for [up-platform](https://github.com/up-deploy/up-platform) — one deployable infrastructure block per entry, consumed **at pinned tags**.

## How consumption works

This repo is never installed as a package. The platform's build workflow checks out this repo at the exact tag recorded in the platform catalog (`source.ref`) and synthesizes one entry:

```bash
npx cdk synth -a "npx ts-node bin/<block>.ts" \
  -c account=<12 digits> -c region=<aws-region> -c companyId=<id> \
  -c appId=<4 chars> -c env=<ring> -c blockRef=<tag> \
  -c blockConfig='<json from config/environments/<ring>.yaml>' -c tags='<json>'
```

A new tag here changes nothing on the platform until a catalog PR in `up-platform` moves the pin.

## Blocks

| Block | Entry | What it builds |
|-------|-------|-----------------|
| [`s3`](blocks/s3/) | `bin/s3.ts` | Private, secure-by-default S3 bucket (public access blocked, SSL-only, encrypted, versioned, access-logged) |

## The block contract

Every block in this repo must:

1. **Compose its own resource name** — `<companyId>-<block>-<appId>-<env>-01`. The caller supplies `appId` only. The `-01` ordinal is a fixed literal today: one instance per (companyId, appId, env).
2. **Tag everything** — the five platform keys (`<companyId>:managed|app-id|env|block|block-ref`) plus the environment's `tags:` map, all namespaced by `lib/platform-tags.ts`; coverage re-checked at synth by `RequiredTagsAspect`.
3. **Validate its inputs** — the entry rejects malformed context values before synth, and `blockConfig` is validated against the block's zod schema (`.strict()` — unknown keys are errors).
4. **Declare its outputs** — `CfnOutput`s matching the catalog entry's `outputs` list; a test asserts they exist.
5. **Fence its policy** — class-3 controls (public access, SSL, encryption, versioning, ownership) are hardcoded with no override prop, and guarded by `POLICY:` tests.
6. **Prove itself** — `npx tsc --noEmit && npm test` green, and the entrypoint must print `compliance: pack=…` so the platform's scan can verify cdk-nag ran.

## Local development

```bash
npm install
npx tsc --noEmit && npm test          # what CI runs
npm run synth:s3 -- -c account=111111111111 -c region=eu-west-1 -c companyId=up \
  -c appId=demo -c env=dev -c blockRef=dev -c tags='{}' \
  -c blockConfig='{"retain":false,"logBucket":"some-log-bucket"}'
```

No AWS credentials needed — everything up to and including the compliance verdict happens at synth.

## Releasing

Gitflow: PR into `develop` (squash) → `gh workflow run release.yml -f bump=patch|minor|major` → merge the release PR into `main` with a **merge commit** → the tag and the merge-back branch are cut automatically. Tags are immutable (ruleset). Full process: `CLAUDE.md`.

The platform adopts the release only when its catalog pin is updated (see [the catalog](https://github.com/up-deploy/up-platform/tree/main/catalog)).
