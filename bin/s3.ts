#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack, S3ConfigSchema } from "../blocks/s3/s3-stack";
import { applyPlatformTags, parseExtraTags, RequiredTagsAspect } from "../lib/platform-tags";
import { parseBlockConfig } from "../lib/block-config";
import { AwsSolutionsChecks } from "cdk-nag";

const app = new cdk.App();

// The platform's catalog gate validates these too, but this repo is public and
// can be synthesized with no router in front of it — the block must hold its own
// contract. appId's pattern here IS the contract; catalog/blocks/s3.yaml mirrors
// it, and the router's accepted set must stay a subset of the block's.
function requireParam(name: string, value: string | undefined, pattern: RegExp): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} not set`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} '${value}' does not match ${pattern.source}`);
  }
  return value;
}


const account = requireParam("AWS Account", app.node.tryGetContext("account"), /^\d{12}$/);
const region = requireParam("Region", app.node.tryGetContext("region"), /^[a-z]{2}-[a-z]+-\d$/);
const environment = requireParam("Environment", app.node.tryGetContext("env"), /^[a-z][a-z0-9]{1,11}$/);
const appId = requireParam("App Id", app.node.tryGetContext("appId"), /^[a-z0-9]{4}$/);
const companyId = requireParam("Company Id", app.node.tryGetContext("companyId"), /^[a-z][a-z0-9]{0,9}$/);
// A tag, a branch or a bare SHA — try-block.sh builds branches, releases build tags.
const blockRef = requireParam("Block Ref", app.node.tryGetContext("blockRef"), /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const cfg = parseBlockConfig(
  app.node.tryGetContext("blockConfig"),
  S3ConfigSchema,
  "s3",
);


const extra = parseExtraTags(app.node.tryGetContext("tags"));


new S3BucketStack(app, "S3", {
  env: { account, region }, companyId, appId, environment, cfg
});

applyPlatformTags(app, {
  companyId,
  appId,
  environment,
  block: "s3",
  blockRef,
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
