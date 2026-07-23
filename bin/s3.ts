#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack, S3Config, S3_CONFIG_KEYS } from "../blocks/s3/s3-stack";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";
import { parseBlockConfig } from "../lib/block-config";
import { AwsSolutionsChecks } from "cdk-nag";

const ACCOUNT_PATTERN = /^\d{12}$/;
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
const cfg = parseBlockConfig<S3Config>(
  app.node.tryGetContext("blockConfig"),
  S3_CONFIG_KEYS,
  "s3",
);
const extra = JSON.parse(app.node.tryGetContext("tags") ?? "{}");


// requireParam already guarantees presence, so only the shape is left to check.
if (!ACCOUNT_PATTERN.test(account)) {
  throw new Error(`AWS Account '${account}' is not a 12-digit account id`);
}

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

// READONLY (1000) so it runs after the tag aspects, which register at DEFAULT (500) because
// cdk.json sets no feature flags. See lib/platform-tags.ts.
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

// A clean run is otherwise SILENT: cdk-nag writes `pluginReports: []` when nothing is
// violated, which is byte-identical to never having registered it. This line is the only
// positive evidence that the control actually executed. stderr, so it survives --quiet.
console.error(
  `compliance: pack=${nagPack.name} cdk-nag=${require("cdk-nag/package.json").version}`
);
