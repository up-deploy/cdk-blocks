#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack } from "../blocks/s3/s3-stack";
import { applyPlatformTags, RequiredTagsAspect } from "../lib/platform-tags";

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
const cfg = JSON.parse(app.node.tryGetContext("blockConfig") ?? "{}");
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