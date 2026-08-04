# cdk-blocks

CDK building blocks for [up-platform](https://github.com/up-deploy/up-platform) — one deployable infrastructure block per entry, consumed **at pinned tags**.

## How consumption works

This repo is never installed as a package. The platform's build workflow checks out this repo at the exact tag recorded in the platform catalog (`source.ref`) and synthesizes the app's whole component list through the ONE entrypoint, `app/app.ts`:

```bash
npx cdk synth -a "npx ts-node app/app.ts" \
  -c account=<12 digits> -c region=<aws-region> -c companyId=<id> \
  -c appId=<4 chars> -c env=<ring> -c tags='<json>' \
  -c components='[{"block":"s3","role":"docs","blockRef":"<tag>","config":{…}}]'
```

What gets built is decided by the component list and the registry (`app/registry.ts`), not by a filename: a block is buildable because it is registered there. Each component carries its own `blockRef` (the catalog pin) and its own `config` blob (from `config/environments/<ring>.yaml`).

A new tag here changes nothing on the platform until a catalog PR in `up-platform` moves the pin.

## Blocks

| Block | Registered as | What it builds |
|-------|---------------|-----------------|
| [`s3`](blocks/s3/) | `s3` in `app/registry.ts` | Private, secure-by-default S3 bucket (public access blocked, SSL-only, encrypted, versioned, access-logged) |

## The block contract

Every block in this repo must:

1. **Compose its own resource name** — `<companyId>-<block>-<appId>[-<role>]-<env>`. The caller supplies `appId`; the request carries the optional `role`. `role` is the ONLY discriminator between two components of the same block, so there is no counter — a name is a pure function of the request and never depends on what else the app holds.
2. **Tag everything** — the platform keys (app tier `<companyId>:managed|app-id|env`; component tier `<companyId>:block|block-ref`, plus `role` when set) and the environment's `tags:` map, all namespaced by `lib/platform-tags.ts`; coverage re-checked at synth by `RequiredTagsAspect`.
3. **Validate its inputs** — the app entrypoint rejects malformed context values before synth (`requireParam`: the pattern passed in IS the contract), the component list is validated against a strict schema (unknown keys, including a legacy `issueId`, are errors), and each component's `config` blob is validated against the block's own zod schema (`.strict()`).
4. **Declare its outputs** — `CfnOutput`s matching the catalog entry's `outputs` list; a test asserts they exist.
5. **Fence its policy** — class-3 controls (public access, SSL, encryption, versioning, ownership) are hardcoded with no override prop, and guarded by `POLICY:` tests.
6. **Prove itself** — `npx tsc --noEmit && npm test` green, and the entrypoint must print `compliance: pack=…` so the platform's scan can verify cdk-nag ran.

## Local development

```bash
npm install
npx tsc --noEmit && npm test          # what CI runs
npm run synth -- -c account=111111111111 -c region=eu-west-1 -c companyId=up \
  -c appId=demo -c env=dev -c tags='{}' \
  -c components='[{"block":"s3","blockRef":"dev","config":{"retain":false,"logBucket":"some-log-bucket"}}]'
```

No AWS credentials needed — everything up to and including the compliance verdict happens at synth.

## Releasing

Gitflow: PR into `develop` (squash) → `gh workflow run release.yml -f bump=patch|minor|major` → merge the release PR into `main` with a **merge commit** → the tag and the merge-back branch are cut automatically. Tags are immutable (ruleset). Full process: `CLAUDE.md`.

The platform adopts the release only when its catalog pin is updated (see [the catalog](https://github.com/up-deploy/up-platform/tree/main/catalog)).
