#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OidcFoundationStack } from "./oidc-stack";
import { applyComponentTags, applyPlatformTags, parseExtraTags, RequiredTagsAspect } from "../lib/platform-tags";
import { requireParam } from "../lib/require-param";
import { AwsSolutionsChecks } from "cdk-nag";

/**
 * The foundation — the trust that lets every later request reach AWS at all.
 *
 * Deliberately NOT in `bin/`. `cdk-build.yml` synthesizes with
 * `-a "npx ts-node bin/$BLOCK_NAME.ts"`, so a file in `bin/` is by definition a block a
 * request can order. The foundation is not orderable: it is deployed once, by hand, by
 * someone holding admin credentials. `check-catalog.sh` would reject the name anyway,
 * but the rule is not to create a shape that then needs guarding.
 *
 * It keeps every block *convention* — context inputs validated at the entrypoint,
 * platform tags, the required-tags aspect, cdk-nag registered here — because those are
 * what make a stack auditable, and the foundation is the last stack that should be
 * exempt from them.
 *
 * Placement is a compromise and worth naming as one: the foundation is
 * installation-specific while `cdk-blocks` is the client-agnostic repo. It lives here
 * because `up-platform` has no CDK tooling at all — no `package.json`, `tsconfig.json`
 * or `cdk.json` — and moving it later is a file copy. Nothing installation-specific is
 * committed: the org, repo and branch all arrive as context.
 */
const app = new cdk.App();

const account = requireParam("AWS Account", app.node.tryGetContext("account"), /^\d{12}$/);
const region = requireParam("Region", app.node.tryGetContext("region"), /^[a-z]{2}-[a-z]+-\d$/);
const environment = requireParam("Environment", app.node.tryGetContext("env"), /^[a-z][a-z0-9]{1,11}$/);
const companyId = requireParam("Company Id", app.node.tryGetContext("companyId"), /^[a-z][a-z0-9]{0,9}$/);
// A tag, a branch or a bare SHA — the foundation is deployed from a working copy, so
// this records which revision of it built the trust.
const blockRef = requireParam("Block Ref", app.node.tryGetContext("blockRef"), /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

// This repo is public. The org, repo and branch that are allowed to reach an AWS
// account are installation facts, so they arrive as context and are never committed.
// The patterns are GitHub's own rules for each: orgs and repos accept a restricted set,
// branch names are far looser but still cannot contain a space or a colon — a colon
// would let a crafted value forge extra fields in the `sub` string built downstream.
const githubOrg = requireParam("GitHub Org", app.node.tryGetContext("githubOrg"), /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const githubRepo = requireParam("GitHub Repo", app.node.tryGetContext("githubRepo"), /^[A-Za-z0-9._-]{1,100}$/);
const githubBranch = requireParam("GitHub Branch", app.node.tryGetContext("githubBranch"), /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

/**
 * Validate the bootstrap qualifier — and deliberately do not pass it anywhere.
 *
 * The value has two consumers that must agree: this stack's trust policy, and CDK's own
 * `DefaultStackSynthesizer`, which resolves `props.qualifier ?? context ?? DEFAULT` and
 * bakes its answer into the deploy role and the `CheckBootstrapVersion` rule. Both now
 * read `BOOTSTRAP_QUALIFIER_CONTEXT` directly, so there is one fact and no way to set
 * half of it. Handing the stack a prop reintroduced exactly that split, and a test caught
 * it — see the note at the read site in `oidc-stack.ts`.
 *
 * So this call is a *gate*, not a source: it fails the synth early, naming the parameter,
 * instead of letting a malformed qualifier reach CloudFormation as a mystery. The pattern
 * is AWS's own — the bootstrap template declares
 * `AllowedPattern: "[A-Za-z0-9_-]{1,10}"` on its `Qualifier` parameter.
 */
requireParam(
  "Bootstrap Qualifier",
  app.node.tryGetContext(cdk.BOOTSTRAP_QUALIFIER_CONTEXT) ??
    cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER,
  /^[A-Za-z0-9_-]{1,10}$/,
);

/**
 * Whether the account already has a GitHub OIDC provider.
 *
 * Context values are strings, and this repo has already paid for that once: a
 * `blockConfig` of `{"retain":"false"}` is a truthy string. So the accepted set is exactly
 * two spellings — `"True"`, `"1"` and `"yes"` are refused loudly rather than quietly
 * meaning true.
 */
const existingOidcProvider =
  requireParam(
    "Existing OIDC Provider",
    app.node.tryGetContext("existingOidcProvider") ?? "false",
    /^(true|false)$/,
  ) === "true";

const extra = parseExtraTags(app.node.tryGetContext("tags"));

/**
 * A reserved appId, hardcoded rather than read from context, so the foundation cannot be
 * deployed under an application's identity.
 *
 * Tagging it at all — rather than skipping `applyPlatformTags` because there is no
 * application — matters because the platform is about to grow an AWS Config
 * `required-tags` rule. Untagged, the very first thing the platform's own compliance
 * rule would report as shadow infrastructure is the platform.
 */
const FOUNDATION_APP_ID = "plat";

/** What this stack is FOR. Hardcoded like the appId: the foundation is not a requestable component. */
const FOUNDATION_ROLE = "oidc";

new OidcFoundationStack(app, "Foundation", {
  env: { account, region },
  githubOrg,
  githubRepo,
  githubBranch,
  environment,
  existingOidcProvider,
});

applyPlatformTags(app, {
  companyId,
  appId: FOUNDATION_APP_ID,
  environment,
  extra,
});

// The foundation is one stack holding one component, so the component tier is applied at app
// scope here. It still emits every key, because B4's AWS Config required-tags rule must not find
// the platform itself reported as shadow infrastructure.
applyComponentTags(app, {
  companyId,
  block: "foundation",
  blockRef,
  role: FOUNDATION_ROLE,
  // Not a portal request — sentinel so the required issue-id tag is present on the
  // foundation itself. App components always carry their real GitHub issue number.
  issueId: "1",
});

cdk.Aspects.of(app).add(new RequiredTagsAspect(companyId), {
  priority: cdk.AspectPriority.READONLY,
});

// The compliance gate, wired exactly as every block wires it. The foundation is
// deployed by hand and never passes through `scan`, which makes it the one stack
// with no second pair of eyes — so it gets the same pack, not a lighter one.
const nagPack = new AwsSolutionsChecks(app, {
  verbose: true,
  writeSuppressionsToCloudFormation: true,
});
cdk.Validations.of(app).addPlugins(nagPack);

console.error(
  `compliance: pack=${nagPack.name} cdk-nag=${require("cdk-nag/package.json").version}`
);
