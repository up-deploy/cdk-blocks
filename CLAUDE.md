# cdk-blocks — working notes

The building blocks themselves. One CDK app; one deployable block per `bin/<name>.ts`.

This repo knows nothing about catalogs, environments or the request flow. It receives
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
| `app/app.ts` | the ONE entrypoint. Reads context, builds an `AppStack`, applies the app-tier tags, registers cdk-nag |
| `app/app-stack.ts` | `AppStack` — one stack per app team per environment, holding every component that team asked for |
| `app/registry.ts` | which block names are buildable, and how. This replaced `bin/<name>.ts` as the selection contract: a block is requestable because it is registered here, not because a file exists |
| `app/component-spec.ts` | the zod schema for the requested component list, incl. the duplicate `(block, role)` check |
| `foundation/` | the OIDC trust that lets CI reach an account at all. Deliberately NOT a block: deployed once by hand with admin credentials, has no `appId`, and must not be requestable. Keeps every block *convention* (context inputs, `applyPlatformTags`, cdk-nag in the entrypoint, `POLICY:` tests) |
| `lib/require-param.ts` | `requireParam()` — one context value or a failed synth. Absent and empty are both refused; the pattern passed in IS the contract |
| `scripts/foundation-preflight.sh` | reads a target account read-only and reports bootstrap version, qualifier, execution policies, trusted accounts and any existing GitHub OIDC provider, then prints the deploy command with the flags that account needs. Reports, never prescribes |
| `blocks/<name>/` | the block itself, a **Construct** — where the policy fence lives. Not a Stack: a stack belongs to an app team, which composes several of these |
| `lib/platform-tags.ts` | `applyPlatformTags()` (app tier), `applyComponentTags()` (component tier) + `RequiredTagsAspect` |
| `lib/naming.ts` | `composeResourceName()` — `<companyId>-<block>-<appId>-<role>-<env>`, plus the `role` pattern. **No counter**: `role` is the whole discriminator, so a name is a pure function of the request and never depends on what else the app holds |
| `lib/block-config.ts` | `parseBlockConfig()` — parses the config blob and validates it against the block's zod schema |
| `lib/outputs.ts` | `publishComponentOutputs()` — writes the DECLARED subset of a component's outputs to SSM at `/<companyId>/<env>/<appId>/<block>/<role>/<Output>`, so one project can hand a live value to another. **Not an inventory**: current values only, nothing else. A component publishes **nothing** by default; what reaches SSM is the catalog's `publishes:`, arriving inside the component spec so this repo still knows nothing about catalogs |
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

# Synth an app by hand, exactly as cdk-build.yml does it. `components` MUST be on one line:
# `-c` values are truncated at the first newline, so a pretty-printed array arrives as `[`.
npx cdk synth -a "npx ts-node app/app.ts" \
  -c account=012514678082 -c region=eu-west-1 -c companyId=up \
  -c appId=a231 -c env=dev -c tags='{}' \
  -c components='[{"block":"s3","role":"docs","blockRef":"v0.5.0","config":{"retain":false,"logBucket":"up-s3-logs-dev-01"}}]'
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
- **The block composes its own resource name** — `<companyId>-<block>-<appId>-<role>-<env>`. The
  caller supplies `appId` and `role` only. Naming is a platform guarantee that tags and cost
  attribution rely on. Two components of the same block are told apart by `role` alone; a request
  for two with the same role is refused at parse time, and the fix is a role that says what the
  second one is FOR, never a sequence number the platform would have to derive.
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

| Branch | From | Merges into | Merge style | Enforced? |
|---|---|---|---|---|
| `feature/*` | `develop` | `develop` | squash *(preferred)* | no — `develop` permits both |
| `chore/*`, `docs/*` | `develop` | `develop` | squash *(preferred)* | no — `develop` permits both |
| `release/*` | `develop` | `main` **and back into `develop`** | **merge commit** | **yes** — `main` permits merge only |
| `hotfix/*` | `main` | `main` **and back into `develop`** | **merge commit** | **yes** — `main` permits merge only |

**Read the last column before assuming the table is a rule.** Verified 2026-07-31 against the live
rulesets: `protect_develop` (`19626985`) allows `["merge","squash"]`, `protect_main_release_style`
(`19666967`) allows `["merge"]`. So squash on a `feature/*` is a **convention** the server does not
enforce, and PR **#23** landed on `develop` as a merge commit without breaking anything. The
merge-commit requirement on `main` is real and enforced.

Two consequences worth keeping straight. A squashed `feature/*` gives `develop` a tidy history, which
is why it stays the preference. And because #23 was a merge commit, its branch head is still reachable
from `develop`, whereas a squash would have orphaned it — which matters if anything recorded that
commit's SHA.

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

Adding a block means a new `blocks/<name>/` **and** an entry in `app/registry.ts`. The registry is
the contract: `cdk-build.yml` always synthesizes `app/app.ts`, and a block is buildable because it
is registered, not because a file was saved in a particular directory.

### 2. Prove it on the real pipeline — before releasing

Dispatch `cdk-build.yml` from up-platform against your branch ref (workflow_dispatch), or
merge a throwaway request that points the catalog pin at a temporary tag only after the
block's own CI (`build` + `scan`) is green on the feature PR. **Do not pin a branch in the
catalog** — `source.ref` must match `^v[0-9]+\.[0-9]+\.[0-9]+$`.

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

Full procedure: `up-platform/docs/blocks.md`. In short — **two PRs in up-platform**:

1. The catalog PR: bump `source.ref` in `catalog/blocks/<name>.yaml` (for a new block, add the
   file), **move every block's pin to the same tag** (an app mixing pins is refused), add any
   `blocks.<name>:` env config, and add the block to `test/fixtures/dev.yaml`. Prove before
   committing: `GITHUB_OUTPUT=/tmp/out ./scripts/check-catalog.sh <block> dev 9999`.
2. The pin-bump PR: update the platform-action SHA in `app-plan.yml`/`app-apply.yml` to the
   catalog PR's merge commit. Requests resolve against the pinned tree — until this lands,
   the change does not exist to them.

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
that was legal yesterday stops being legal. And because the catalog's accepted set must stay a
*subset* of the block's, a stricter block deadlocks every request the catalog still approves —
so a major bump on inputs means checking `check-catalog.sh` in the same change.

## Related

- `up-platform/CLAUDE.md` — the platform side: request workflow, catalog, policy gate, shared gotchas
- `docs/tagging-schema.md` — the tag contract this repo implements
- `Wiki/wiki/projects/upstood/up-platform/_status.md` — status; `decision-log.md` — the whys
