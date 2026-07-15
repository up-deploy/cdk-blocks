#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { S3BucketStack } from "../blocks/s3/s3-stack";

const INSTANCE_PATTERN = /^[a-z][a-z0-9-]{2,20}$/;

const app = new cdk.App();

const instance = app.node.tryGetContext("instance") as string | undefined;
const environment = (app.node.tryGetContext("env") as string | undefined) ?? "dev";

if (!instance || !INSTANCE_PATTERN.test(instance)) {
  throw new Error(
    `Context 'instance' is required and must match ${INSTANCE_PATTERN} — pass it with: -c instance=<name>`,
  );
}

const stack = new S3BucketStack(app, `upp-s3-${instance}-${environment}`, {
  instance,
  environment,
});

// Standard platform tags — the contract every block satisfies.
cdk.Tags.of(stack).add("company", "upstood");
cdk.Tags.of(stack).add("appId", "upp");
cdk.Tags.of(stack).add("environment", environment);
cdk.Tags.of(stack).add("owner", "aleks");
cdk.Tags.of(stack).add("upp:component", "s3");
cdk.Tags.of(stack).add("upp:instance", instance);
