# cdk-blocks — working notes

The building blocks themselves. One CDK app; one deployable block per `bin/<name>.ts`.

This repo knows nothing about catalogs, environments, issue forms or requests. It receives
context values and builds a resource. Everything that decides *whether a request is allowed*
lives in `up-platform`. Keeping that boundary is what lets this repo travel unchanged to every
client.

**Public repo.** No account IDs, no client names, no config. A full-history secret scan ran before
it was made public on 2026-07-23; keep it that way.

**Learning mode: Aleks hand-writes the code.** Guide one small step per reply, then stop and wait.
Do not implement several steps ahead, and do not write code he has not asked for.

## Layout

| Path | What |
|---|---|
| `bin/<name>.ts` | the block's entrypoint — reads context, composes the name, applies tags, registers cdk-nag |
| `blocks/<name>/` | the stack and its constructs — where the policy fence lives |
| `lib/platform-tags.ts` | `applyPlatformTags()` + `RequiredTagsAspect`, shared by every block |
| `lib/block-config.ts` | `parseBlockConfig()` — parses the config blob and validates it against the block's zod schema |
| `test/<name>.test.ts` | `Template.fromStack()` assertions, incl. the `POLICY:`-prefixed ones |
| `.github/workflows/ci.yml` | `build` (tsc + tests) and `scan` (proves the entrypoint wires cdk-nag) |
| `.github/workflows/naming.yml` | `naming` — branch slug, Conventional-Commits PR title, PR direction |
| `.github/workflows/release.yml` | cuts `release/vX.Y.Z` off `develop` and bumps the version |
| `.github/workflows/tag-and-merge-back.yml` | on push to `main`: cuts the tag, prepares the merge-back |

Shared gotchas (the tag trap, `-c` values always being strings, `GITHUB_OUTPUT` line-format, the
`actionlint` false positive, CDK aspect priority) are documented once in
`up-platform/CLAUDE.md` and `docs/tagging-schema.md`. **Do not restate them here** — two copies
drift, which is the same reasoning that deleted the catalog's `version:` field.

## Commands

```bash
npx tsc --noEmit && npm test          # what CI runs

# Synth a block by hand, exactly as cdk-build.yml does it
npx cdk synth -a "npx ts-node bin/s3.ts" \
  -c account=012514678082 -c region=eu-west-1 -c companyId=up \
  -c appId=a231 -c env=dev -c blockRef=v0.2.0 -c tags='{}' \
  -c blockConfig='{"retain":false,"logBucket":"up-s3-logs-dev-01"}'
```

`logBucket` is not optional in practice: the `AwsSolutions-S1` acknowledgement was removed, so a
bucket with no logging destination fails the synth. That is deliberate — logging is mandatory.

The synth prints `compliance: pack=AwsSolutions cdk-nag=<version>` on stderr. **That line is the
only positive evidence the compliance gate executed** — a clean cdk-nag run writes
`pluginReports: []` and names nothing it checked. If the line is missing, the `scan` job in
`up-platform` returns `not verified` and fails the request, by design.

## The block contract

A block is a unit of *release*, so its public surface has to be stable and small:

- **Inputs** — `appId` (class 1, from the request) and `blockConfig` (class 2, from the
  environment file). Nothing else. Both are declared in `catalog/blocks/<name>.yaml`.
- **Outputs** — declared in the same catalog entry; a test asserts the block actually emits them.
- **Policy is class 3 and never an input.** Private access, SSL-only and encryption are fenced in
  block code with no override prop. A policy that is a prop with a default is a suggestion.
- **The block composes its own resource name** — `<companyId>-<block>-<appId>-<env>-01`. The caller
  supplies `appId` only. Naming is a platform guarantee that tags and cost attribution rely on.
- **`blockConfig` is validated against a zod schema** — `<Block>ConfigSchema`, exported from the
  block's stack file and passed to `parseBlockConfig()`. The schema is the **single** definition:
  `.strict()` rejects unknown keys, each field fixes its type, and the TS type is `z.infer`red from
  it, so adding a parameter is one line in one place. Without this a typo'd key was silently
  ignored — `{"retian":true}` synthesized `DeletionPolicy: Delete` and exited 0 while the
  environment file asked for the bucket to be **retained**. The schema also catches what a key list
  could not: `{"retain":"false"}` is a string, which is truthy, and is now rejected rather than
  coerced. The accepted set is never mirrored into the catalog.

## Branching — Gitflow since 2026-07-23

`develop` is the **default branch** and where work lands. `main` holds only released code and
carries the tags. Both are protected: PR required, `build` + `scan` + `naming` must be green,
no force-push, no deletion, **zero bypass actors**.

| Branch | From | Merges into | Merge style |
|---|---|---|---|
| `feature/*` | `develop` | `develop` | squash |
| `chore/*`, `docs/*` | `develop` | `develop` | squash |
| `release/*` | `develop` | `main` **and back into `develop`** | **merge commit** |
| `hotfix/*` | `main` | `main` **and back into `develop`** | **merge commit** |

Branch names are enforced server-side — anything off that allowlist is refused at `git push` with
`GH013`. `feat/`, `fix/` and `ci/` are **retired**; ordinary bug fixes are `feature/`, and
`hotfix/` means "main is broken in production right now".

> ⚠️ Never squash a `release/*` or `hotfix/*` into `main`. The merge-back into `develop` then
> compares one squashed commit against the commits it was built from and conflicts — on that
> release and every release after it.

Full standard, including the PR-title format: `Wiki/wiki/standards/git-branch-commit-standard.md`.

## Changing a block, or adding one

Four stages. The tag is the point of no return — everything before it is reversible, nothing
after it is.

### 1. Develop

```bash
git checkout develop && git pull
git checkout -b feature/<something>
# edit bin/<name>.ts, blocks/<name>/, test/<name>.test.ts
npx tsc --noEmit && npm test
npx cdk synth -a "npx ts-node bin/<name>.ts" -c ...   # read the template AND the nag verdict
```

Adding a block means a new `bin/<name>.ts` **and** a new `blocks/<name>/`. The entrypoint name is
the contract: `cdk-build.yml` synthesizes with `-a "npx ts-node bin/$BLOCK_NAME.ts"`, so the file
name *is* how a request selects the block.

### 2. Prove it on the real pipeline — before releasing

```bash
# from the up-platform repo
scripts/try-block.sh <block> <env> <appId> <your-branch>
```

Runs the actual `cdk-build.yml`: checkout at your ref, synth, cdk-nag, and the `scan` verdict.
The full policy gate still applies — only *which ref gets checked out* is overridden. **No tag is
cut and the catalog is not touched.**

This is the step that replaces "deploy to dev and see". It is also structurally safe: the catalog
requires `source.ref` to match `^v[0-9]+\.[0-9]+\.[0-9]+$`, so a branch can be built this way but
can never be pinned.

### 3. Release — mostly automated

PR into `develop` → three checks green → squash-merge. Then:

```bash
gh workflow run release.yml -f bump=patch     # or minor / major
```

That cuts `release/vX.Y.Z` off `develop` and bumps `package.json`. **Open the PR into `main`
yourself** and merge it with a **merge commit**. Merging fires `tag-and-merge-back.yml`, which cuts
the annotated tag and prepares `chore/merge-back-vX.Y.Z` — open and merge that too.

Neither workflow opens a PR, and neither needs a stored token. A PR opened with `GITHUB_TOKEN`
does not trigger `pull_request` workflows, so the required checks would never report and the PR
would be unmergeable forever; the alternative is a long-lived PAT in a **public** repo. You click
instead.

The next version is derived from the **latest tag**, never from `package.json` — the two drifted
once (`package.json` said `0.1.0` while `v0.2.0` was shipped), and deriving from the tag makes that
self-healing.

**Tags are immutable** (ruleset `19618738` on `refs/tags/v*`, no bypass actors). You cannot move or
delete one. Before this ruleset a tag shipped the wrong code three times, and one delete-then-recreate
left a window where the pin did not exist at all and a live request died at checkout.

Verify the tag means what you think: `git show v0.3.0:bin/<name>.ts`.

> Skipping the merge-back is the one Gitflow mistake that bites later: the release lives only on
> `main` and the next release silently reverts it. Nothing reports an error when that happens.

### 4. Publish to the platform

In `up-platform`, on a branch:

```bash
# bump source.ref in catalog/blocks/<name>.yaml, then prove it BEFORE committing
GITHUB_OUTPUT=/tmp/out ./scripts/check-catalog.sh <block> dev <appId>
```

Open a PR. **That PR is the promotion event** — its diff is one line, and its git history is the
audit log of what the platform offered and when.

For a *new* block, the same PR also adds `catalog/blocks/<name>.yaml` and a matching option in
`.github/ISSUE_TEMPLATE/building-block-issue-form.yml`. Those two are hand-synced today, which is
the known menu-drift gap (roadmap C1).

There is one pin per block, shared by dev and prod. That is deliberate: a per-environment pin
would mean prod runs different *code* from dev, breaking "prod differs by values, not code".
Deployed resources are unaffected by a bump — they keep the `block-ref` they were built with, and
the gap between that and the catalog is the upgrade backlog.

## Versioning

The catalog entry is the block's public contract, so semver is defined against it:

| Change | Bump |
|---|---|
| Remove or rename a declared input or output; tighten an input's accepted values | **major** |
| Add an optional input; add a new output; add a new block | **minor** |
| Fix behaviour with the same contract; internal refactor; docs; tests | **patch** |

Two consequences worth stating. Tightening what an input accepts is **major**, because a request
that was legal yesterday stops being legal. And because the router's accepted set must stay a
*subset* of the block's, a stricter block deadlocks every request the router still approves —
so a major bump on inputs means checking `check-catalog.sh` in the same change.

## Related

- `up-platform/CLAUDE.md` — the platform side: router, catalog, policy gate, shared gotchas
- `docs/tagging-schema.md` — the tag contract this repo implements
- `Wiki/wiki/projects/upstood/up-platform/_status.md` — status; `decision-log.md` — the whys
