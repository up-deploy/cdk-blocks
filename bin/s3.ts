#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack } from "../blocks/s3/s3-stack";


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
const cfg = JSON.parse(app.node.tryGetContext("blockConfig") ?? "{}");


if (!account || !ACCOUNT_PATTERN.test(account)) {
  throw new Error(
    `AWS Account not set`,
  );  
}


new S3BucketStack(app, "S3", { 
  env: { account, region }, companyId, appId, environment, cfg
});

