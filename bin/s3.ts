#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack, S3ConfigSchema } from "../blocks/s3/s3-stack";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";
import { parseBlockConfig } from "../lib/block-config";
import { AwsSolutionsChecks } from "cdk-nag";

const app = new cdk.App();

function requireParam(name: string, value?: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} not set`);
  }
  return value;
}


const account = requireParam("AWS Account", app.node.tryGetContext("account"));
const region = requireParam("Region", app.node.tryGetContext("region"));
const environment = requireParam("Environment", app.node.tryGetContext("env"));
const appId = requireParam("App Id", app.node.tryGetContext("appId"));
const companyId = requireParam("Company Id", app.node.tryGetContext("companyId"));
const blockRef = requireParam("Block Ref", app.node.tryGetContext("blockRef"));
const cfg = parseBlockConfig(
  app.node.tryGetContext("blockConfig"),
  S3ConfigSchema,
  "s3",
);


const extra = JSON.parse(app.node.tryGetContext("tags") ?? "{}");


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
