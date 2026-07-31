import { App, BOOTSTRAP_QUALIFIER_CONTEXT } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { OidcFoundationStack } from "../foundation/oidc-stack";

const ACCOUNT = "111122223333";
const REGION = "eu-west-1";

const DEFAULT_QUALIFIER = "hnb659fds";

interface Overrides {
  githubOrg?: string;
  githubRepo?: string;
  githubBranch?: string;
  environment?: string;
  bootstrapQualifier?: string;
  existingOidcProvider?: boolean;
}

/**
 * The qualifier is set the only way it can be set — on the App's context, the same key
 * `DefaultStackSynthesizer` reads. There is deliberately no prop for it: a prop could be
 * set without the context key and split the stack's grants from its own deployment.
 */
function synth(overrides: Overrides = {}) {
  const app = new App({
    context: overrides.bootstrapQualifier
      ? { [BOOTSTRAP_QUALIFIER_CONTEXT]: overrides.bootstrapQualifier }
      : {},
  });
  const stack = new OidcFoundationStack(app, "Foundation", {
    env: { account: ACCOUNT, region: REGION },
    githubOrg: overrides.githubOrg ?? "an-org",
    githubRepo: overrides.githubRepo ?? "a-repo",
    githubBranch: overrides.githubBranch ?? "main",
    environment: overrides.environment ?? "dev",
    existingOidcProvider: overrides.existingOidcProvider,
  });
  return Template.fromStack(stack);
}

describe("oidc foundation (GitHub Actions trust into an AWS account)", () => {
  const template = synth();

  test("creates the GitHub OIDC provider for the expected issuer", () => {
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
  });

  test("no custom-resource Lambda is synthesized", () => {
    // The L2 OpenIdConnectProvider ships a Lambda to fetch a thumbprint AWS no
    // longer verifies. Choosing the L1 is what keeps this stack free of a function,
    // an execution role and their cdk-nag findings — assert it, or a future
    // "simplification" back to the L2 lands unnoticed.
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  test("POLICY: the trust is federated to this provider, by web identity only", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Effect: "Allow",
            Principal: { Federated: { "Fn::GetAtt": ["GitHubOidcProvider", "Arn"] } },
          }),
        ]),
      },
    });
  });

  test("POLICY: the sub claim is pinned to one repo and one branch", () => {
    // This condition IS the security boundary. Everything else in the stack is
    // plumbing; if this widens, any workflow in the org reaches the account.
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub":
                  "repo:an-org/a-repo:ref:refs/heads/main",
              },
            },
          }),
        ]),
      },
    });
  });

  test("POLICY: the aud condition is always present", () => {
    // Without `aud`, the role would accept a token minted for a different audience.
    // Asserted separately from `sub` so deleting it fails its own named test.
    const roles = template.findResources("AWS::IAM::Role");
    for (const role of Object.values(roles)) {
      for (const stmt of role.Properties.AssumeRolePolicyDocument.Statement) {
        expect(
          stmt.Condition?.StringEquals?.["token.actions.githubusercontent.com:aud"],
        ).toBe("sts.amazonaws.com");
      }
    }
  });

  test("POLICY: no statement in the trust policy uses a wildcard sub", () => {
    const roles = template.findResources("AWS::IAM::Role");
    for (const role of Object.values(roles)) {
      for (const stmt of role.Properties.AssumeRolePolicyDocument.Statement) {
        const sub = stmt.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"];
        expect(sub).toBeDefined();
        expect(sub).not.toContain("*");
      }
    }
  });

  test("POLICY: the role may only assume the CDK bootstrap roles", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: [
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-${REGION}`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-file-publishing-role-${ACCOUNT}-${REGION}`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-image-publishing-role-${ACCOUNT}-${REGION}`,
              `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-lookup-role-${ACCOUNT}-${REGION}`,
            ],
          },
        ],
      },
    });
  });

  test("POLICY: no permission anywhere uses a wildcard resource or action", () => {
    // The whole claim of this design is that the GitHub-assumed role is a key to a
    // keyring. A single `*` that slips in later invalidates that sentence, and would
    // also be unacknowledgeable: cdk-nag's granular IAM5 finding id embeds an ARN,
    // and Validations.acknowledge() rejects ids containing more than one `::`.
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        for (const value of [stmt.Action, stmt.Resource].flat()) {
          expect(typeof value).toBe("string");
          expect(value).not.toContain("*");
        }
      }
    }
  });

  test("POLICY: cfn-exec-role is not assumable — CloudFormation assumes it, not CI", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).not.toContain("cfn-exec-role");
  });

  test("the role carries no managed policies", () => {
    const roles = template.findResources("AWS::IAM::Role");
    for (const role of Object.values(roles)) {
      expect(role.Properties.ManagedPolicyArns ?? []).toEqual([]);
    }
  });

  test("session duration is capped at an hour", () => {
    template.hasResourceProperties("AWS::IAM::Role", { MaxSessionDuration: 3600 });
  });

  test("the role name is derived from the environment", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "UppDeployRole-dev" });
    synth({ environment: "prod" }).hasResourceProperties("AWS::IAM::Role", {
      RoleName: "UppDeployRole-prod",
    });
  });

  test("the subject follows the org, repo and branch it was given", () => {
    const other = synth({
      githubOrg: "other-org",
      githubRepo: "other-repo",
      githubBranch: "release/v1",
    });
    other.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:sub":
                  "repo:other-org/other-repo:ref:refs/heads/release/v1",
              },
            },
          }),
        ]),
      },
    });
  });

  test("emits the role ARN, provider ARN and the trusted subject", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs).sort()).toEqual([
      "DeployRoleArn",
      "OidcProviderArn",
      "TrustedSubject",
    ]);
  });

  test("by default exactly one provider is created", () => {
    template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });

  describe("a bootstrap that did not use the default qualifier", () => {
    // The qualifier was hardcoded to `hnb659fds` while this repo is downloaded and run
    // against accounts its author never sees. A custom-qualifier bootstrap would have
    // produced a stack that deploys cleanly and grants assume on four roles that do not
    // exist — every later deploy failing with AccessDenied pointing at nothing.
    const custom = synth({ bootstrapQualifier: "acme_01" });

    test("POLICY: the bootstrap ARNs follow the qualifier they were given", () => {
      custom.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Resource: [
                `arn:aws:iam::${ACCOUNT}:role/cdk-acme_01-deploy-role-${ACCOUNT}-${REGION}`,
                `arn:aws:iam::${ACCOUNT}:role/cdk-acme_01-file-publishing-role-${ACCOUNT}-${REGION}`,
                `arn:aws:iam::${ACCOUNT}:role/cdk-acme_01-image-publishing-role-${ACCOUNT}-${REGION}`,
                `arn:aws:iam::${ACCOUNT}:role/cdk-acme_01-lookup-role-${ACCOUNT}-${REGION}`,
              ],
            },
          ],
        },
      });
    });

    test("no default-qualifier ARN survives anywhere in the template", () => {
      // A partially-applied qualifier is worse than none: the grant would be split
      // across two bootstraps and fail on whichever half is missing.
      expect(JSON.stringify(custom.toJSON())).not.toContain(DEFAULT_QUALIFIER);
    });

    test("POLICY: the granted qualifier is the one the synthesizer itself used", () => {
      // The invariant, stated independently of how the qualifier is plumbed. The roles
      // this stack grants assume on must belong to the same bootstrap that deploys it,
      // so the assertion reads the qualifier back out of CDK's own CheckBootstrapVersion
      // parameter — written by the synthesizer, not by this stack.
      //
      // This is the test that caught the qualifier arriving as a prop: the IAM policy
      // said `acme_01` while the synthesizer still pointed at `/cdk-bootstrap/hnb659fds/`.
      for (const qualifier of [DEFAULT_QUALIFIER, "acme_01"]) {
        const rendered = synth({ bootstrapQualifier: qualifier }).toJSON();
        expect(rendered.Parameters.BootstrapVersion.Default).toBe(
          `/cdk-bootstrap/${qualifier}/version`,
        );
        expect(JSON.stringify(rendered.Resources)).toContain(`cdk-${qualifier}-deploy-role-`);
      }
    });
  });

  describe("an account that already has a GitHub OIDC provider", () => {
    // AWS allows one provider per issuer per account, so on any account that has ever
    // wired GitHub Actions to AWS, creating it again fails with EntityAlreadyExists.
    const imported = synth({ existingOidcProvider: true });

    test("the provider is referenced, not created", () => {
      imported.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    });

    test("POLICY: the trust federates to the derived provider ARN", () => {
      imported.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sts:AssumeRoleWithWebIdentity",
              Principal: {
                Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
              },
            }),
          ]),
        },
      });
    });

    test("POLICY: aud and sub are pinned on the imported path too", () => {
      // The conditions are the security boundary, and they are asserted separately for
      // this path: a branch that skips resource creation is exactly where a missing
      // condition would go unnoticed.
      const roles = imported.findResources("AWS::IAM::Role");
      expect(Object.keys(roles)).toHaveLength(1);
      for (const role of Object.values(roles)) {
        for (const stmt of role.Properties.AssumeRolePolicyDocument.Statement) {
          expect(stmt.Condition.StringEquals["token.actions.githubusercontent.com:aud"]).toBe(
            "sts.amazonaws.com",
          );
          expect(stmt.Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe(
            "repo:an-org/a-repo:ref:refs/heads/main",
          );
        }
      }
    });

    test("still emits all three outputs", () => {
      expect(Object.keys(imported.findOutputs("*")).sort()).toEqual([
        "DeployRoleArn",
        "OidcProviderArn",
        "TrustedSubject",
      ]);
    });
  });
});
