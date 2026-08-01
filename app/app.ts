#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { AppStack } from "./app-stack";
import { parseComponents } from "./component-spec";
import { applyPlatformTags, parseExtraTags, RequiredTagsAspect } from "../lib/platform-tags";
import { requireParam } from "../lib/require-param";

/**
 * The ONE entrypoint. `bin/<name>.ts` used to be the selection contract — a file there made a
 * block requestable — but a stack now belongs to an app team rather than to a block, so what
 * gets built is decided by the requested component list and the registry, not by a filename.
 */
const app = new cdk.App();

const account = requireParam("AWS Account", app.node.tryGetContext("account"), /^\d{12}$/);
const region = requireParam("Region", app.node.tryGetContext("region"), /^[a-z]{2}-[a-z]+-\d$/);
const environment = requireParam("Environment", app.node.tryGetContext("env"), /^[a-z][a-z0-9]{1,11}$/);
const appId = requireParam("App Id", app.node.tryGetContext("appId"), /^[a-z0-9]{4}$/);
const companyId = requireParam("Company Id", app.node.tryGetContext("companyId"), /^[a-z][a-z0-9]{0,9}$/);

const components = parseComponents(app.node.tryGetContext("components"));
const extra = parseExtraTags(app.node.tryGetContext("tags"));

// One stack per app per environment. A second stack for the same app and ring is not a thing the
// platform creates, and a name that implied otherwise would invite it.
const stackName = `${companyId}-${appId}-${environment}`;

new AppStack(app, "App", {
  stackName,
  env: { account, region },
  companyId,
  appId,
  environment,
  components,
});

// App tier only. `block`, `block-ref` and `role` are applied by each component to itself, because
// this stack holds several of them and has no single block or ref to state.
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
