#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack, S3ConfigSchema } from "../blocks/s3/s3-stack";
import { applyPlatformTags, parseExtraTags, RequiredTagsAspect } from "../lib/platform-tags";
import { parseBlockConfig } from "../lib/block-config";
import { requireParam } from "../lib/require-param";
import { ROLE_PATTERN, SEQ_PATTERN } from "../lib/naming";
import { AwsSolutionsChecks } from "cdk-nag";

const app = new cdk.App();

const account = requireParam("AWS Account", app.node.tryGetContext("account"), /^\d{12}$/);
const region = requireParam("Region", app.node.tryGetContext("region"), /^[a-z]{2}-[a-z]+-\d$/);
const environment = requireParam("Environment", app.node.tryGetContext("env"), /^[a-z][a-z0-9]{1,11}$/);
const appId = requireParam("App Id", app.node.tryGetContext("appId"), /^[a-z0-9]{4}$/);
const companyId = requireParam("Company Id", app.node.tryGetContext("companyId"), /^[a-z][a-z0-9]{0,9}$/);
// A tag, a branch or a bare SHA — try-block.sh builds branches, releases build tags.
const blockRef = requireParam("Block Ref", app.node.tryGetContext("blockRef"), /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
// What the resource is FOR. Class 1, like appId: it comes from the request, and it is what
// keeps two buckets in one app's stack distinguishable. The pattern is defined once, in
// lib/naming.ts, and enforced again when the name is composed.
const role = requireParam("Role", app.node.tryGetContext("role"), ROLE_PATTERN);
// Optional: `01` unless this app already has a bucket with the same role.
const seqRaw = app.node.tryGetContext("seq");
const seq = seqRaw === undefined ? undefined : requireParam("Seq", seqRaw, SEQ_PATTERN);
const cfg = parseBlockConfig(
  app.node.tryGetContext("blockConfig"),
  S3ConfigSchema,
  "s3",
);


const extra = parseExtraTags(app.node.tryGetContext("tags"));


new S3BucketStack(app, "S3", {
  env: { account, region }, companyId, appId, environment, role, seq, blockRef, cfg
});

// App tier only. `block`, `block-ref` and `role` describe one component and are applied by the
// construct itself — an app stack holds several components and has no single block or ref.
applyPlatformTags(app, {
  companyId,
  appId,
  environment,
  extra,
});

cdk.Aspects.of(app).add(new RequiredTagsAspect(companyId), {
  priority: cdk.AspectPriority.READONLY,
});

// The compliance gate. `writeSuppressionsToCloudFormation` copies every acknowledgement
// and its reason into the template's resource Metadata, so an auditor can read the
// exceptions straight out of AWS with GetTemplate instead of needing the source repo.
const nagPack = new AwsSolutionsChecks(app, {
  verbose: true,
  writeSuppressionsToCloudFormation: true,
});
cdk.Validations.of(app).addPlugins(nagPack);

// scan (cdk-build.yml) greps stderr for `^compliance: pack=` — remove this and every
// request fails `not verified`. See decision-log D-005.
console.error(
  `compliance: pack=${nagPack.name} cdk-nag=${require("cdk-nag/package.json").version}`
);
