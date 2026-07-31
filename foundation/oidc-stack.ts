import {
  BOOTSTRAP_QUALIFIER_CONTEXT,
  CfnOutput,
  DefaultStackSynthesizer,
  Duration,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * GitHub's OIDC issuer, and the audience AWS expects.
 *
 * `aud` is `sts.amazonaws.com` because that is what `aws-actions/configure-aws-credentials`
 * requests. It is pinned in the trust policy rather than left open: without an `aud`
 * condition the role would accept a token minted for a different service.
 */
const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const STS_AUDIENCE = "sts.amazonaws.com";

export interface OidcFoundationStackProps extends StackProps {
  /** The GitHub org or user that owns the platform repo. */
  readonly githubOrg: string;
  /** The platform repo — the only repo whose workflows may reach this account. */
  readonly githubRepo: string;
  /** The branch whose runs may assume the role. */
  readonly githubBranch: string;
  /** The environment ring this account is. Names the role. */
  readonly environment: string;

  /**
   * Whether this account *already* has an OIDC provider for GitHub's issuer.
   *
   * AWS permits exactly one provider per issuer per account, so on any account that has
   * ever wired GitHub Actions to AWS — which is most of them — creating it again fails
   * the deploy with `EntityAlreadyExists`. When true, the provider is referenced by its
   * derived ARN instead of created.
   *
   * The ARN is derived rather than pasted in, because for a fixed issuer and account
   * there is exactly one possible value, and asking for it would only add a way to get
   * it wrong. What cannot be derived is whether the existing provider lists
   * `sts.amazonaws.com` in its client IDs — if it does not, the token exchange fails at
   * runtime with the trust policy looking perfectly correct. That is a preflight check,
   * not something this stack can see.
   *
   * @default false — create it
   */
  readonly existingOidcProvider?: boolean;
}

/**
 * The platform's way into an AWS account: an OIDC trust from GitHub Actions, and one
 * role for the workflow to assume.
 *
 * Nothing is stored. There is no access key in GitHub — the workflow presents a
 * short-lived token GitHub itself minted, and the trust policy decides whether the
 * claims in it are acceptable. That is the whole point of the mechanism, and it matters
 * doubly in a repo that already had an app token sitting next to `npm ci`.
 *
 * This stack cannot deploy into an account that has not been bootstrapped, and
 * `cdk bootstrap` can only be run imperatively with admin credentials. So the platform's
 * first entry point into an account is unavoidably one human command, and everything
 * after it is code. An IaC platform cannot create its own front door in IaC.
 */
export class OidcFoundationStack extends Stack {
  public readonly deployRole: iam.Role;
  /** The provider this stack created — `undefined` when it imported an existing one. */
  public readonly provider?: iam.CfnOIDCProvider;
  /** The provider the trust is federated to, created or pre-existing. */
  public readonly providerArn: string;

  constructor(scope: Construct, id: string, props: OidcFoundationStackProps) {
    super(scope, id, props);

    /**
     * The L1, deliberately.
     *
     * `iam.OpenIdConnectProvider` (the L2) deploys a custom-resource Lambda whose only
     * job is to fetch the issuer's TLS thumbprint — which AWS stopped verifying for
     * well-known issuers, and which `thumbprintList` therefore makes optional. The L2
     * would add a Lambda, its execution role and a managed policy to a synth where
     * cdk-nag warnings fail the build, so the convenience construct costs several
     * acknowledgements for machinery that does nothing.
     *
     * One provider per issuer per account is the AWS limit, so a second install into
     * the same account must import this rather than create it.
     */
    if (props.existingOidcProvider) {
      // Derived, not created. There is one legal ARN for this issuer in this account, so
      // there is nothing to look up and nothing to mistype. Note the partition is fixed to
      // `aws`, matching the bootstrap-role ARNs below — this stack does not support
      // aws-cn or aws-us-gov, and would need `this.partition` throughout to do so.
      this.providerArn = `arn:aws:iam::${this.account}:oidc-provider/${GITHUB_OIDC_HOST}`;
    } else {
      this.provider = new iam.CfnOIDCProvider(this, "GitHubOidcProvider", {
        url: GITHUB_OIDC_URL,
        clientIdList: [STS_AUDIENCE],
      });
      this.providerArn = this.provider.attrArn;
    }

    /**
     * The claim that decides everything.
     *
     * `ref:refs/heads/<branch>` and not a wildcard: the router runs on `issues: [opened]`,
     * and issue-triggered runs always execute on the default branch, so this matches the
     * real request path exactly. A `workflow_dispatch` run from a feature branch — which
     * is how `try-block.sh` works — presents a different `sub` and is refused, keeping
     * branch experiments synth-only.
     *
     * Read the limit honestly: `up-platform` is private on a Free plan, where branch
     * protection is not available, so "runs on main" means "runs on whatever reached
     * main". This condition bounds which *workflow context* can reach AWS. It is not a
     * review gate, and nothing here should be read as one.
     */
    const subject = `repo:${props.githubOrg}/${props.githubRepo}:ref:refs/heads/${props.githubBranch}`;

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: `UppDeployRole-${props.environment}`,
      description:
        `Assumed by GitHub Actions from ${props.githubOrg}/${props.githubRepo} ` +
        `on ${props.githubBranch}. Holds no deployment permissions of its own.`,
      assumedBy: new iam.WebIdentityPrincipal(this.providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: STS_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: subject,
        },
      }),
      // A synth-and-deploy run is minutes. The default is an hour; there is no reason
      // for a credential to outlive the job that asked for it.
      maxSessionDuration: Duration.hours(1),
    });

    /**
     * The role's only permission — and the reason it is safe to hand to CI.
     *
     * It can assume the four roles `cdk bootstrap` created, and do nothing else. The
     * actual power to create infrastructure lives in the bootstrap stack's
     * `--cloudformation-execution-policies`, which is where it can be reviewed once
     * rather than maintained per-workflow. So least privilege here is a property of the
     * design, not a list somebody has to keep trimming: the tutorial default of
     * `AdministratorAccess` on the GitHub role is not a shortcut past this, it is a
     * different and worse architecture.
     *
     * A key to a keyring, not to the account.
     *
     * The four roles are ENUMERATED rather than matched with `cdk-<qualifier>-*`, and the
     * reason is worth recording because it is not the obvious one. A wildcard here raises
     * `AwsSolutions-IAM5`, which is a *granular* cdk-nag rule: it can only be acknowledged
     * with the finding-specific id `AwsSolutions-IAM5[Resource::<arn>]`. CDK's
     * `Validations.acknowledge()` rejects any id containing more than one `::`, because it
     * reserves that as its own prefix delimiter — and every IAM ARN contains `arn:aws:iam::`.
     * So the acknowledgement for a wildcard *resource* is unrepresentable in
     * cdk-nag 3.0.1 + aws-cdk-lib 2.261.0. (cdk-nag's own documented example,
     * `AwsSolutions-IAM5[Action::s3:*]`, happens to contain exactly one `::` and works.)
     *
     * Since warnings fail the synth and there is no advisory tier, the wildcard was not a
     * choice between two legal designs — it was unbuildable. Enumeration is the better
     * shape anyway: if a future bootstrap adds a role, this fails loudly with AccessDenied
     * instead of quietly granting whatever the wildcard swept up.
     *
     * `cdk-<qualifier>-cfn-exec-role` is deliberately absent. CloudFormation assumes that
     * one, not the CLI, so granting it here would widen the role for nothing.
     */
    /**
     * The qualifier is read from context, and taking it as a prop instead was a bug.
     *
     * `cdk bootstrap` names its roles `cdk-<qualifier>-...`, and `hnb659fds` is only the
     * default. Hardcoding it was correct for an account bootstrapped the default way, and
     * this repo is downloaded and run against accounts its author never sees — a custom
     * qualifier there produces a stack that deploys perfectly and grants assume on four
     * roles that do not exist, with every later deploy failing `AccessDenied` and nothing
     * naming the cause.
     *
     * But a *prop* is no better, because the qualifier has a second consumer: this stack's
     * own synthesizer, which reads `BOOTSTRAP_QUALIFIER_CONTEXT` and bakes its choice into
     * the `CheckBootstrapVersion` rule and the deploy role the CLI assumes. A prop can be
     * set without the context key, and then the policy grants one qualifier while the
     * deployment uses another. That is exactly the silent disagreement the constant's
     * original comment warned about, and a test caught it here.
     *
     * Reading the same key CDK reads is what makes them one fact rather than two.
     */
    const bootstrapQualifier =
      this.node.tryGetContext(BOOTSTRAP_QUALIFIER_CONTEXT) ??
      DefaultStackSynthesizer.DEFAULT_QUALIFIER;

    const bootstrapRoles = ["deploy", "file-publishing", "image-publishing", "lookup"].map(
      (purpose) =>
        `arn:aws:iam::${this.account}:role/cdk-${bootstrapQualifier}-${purpose}-role-${this.account}-${this.region}`,
    );

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoles,
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: this.deployRole.roleArn,
      description: "Role for aws-actions/configure-aws-credentials to assume",
    });
    new CfnOutput(this, "OidcProviderArn", {
      value: this.providerArn,
      description: "ARN of the GitHub Actions OIDC provider",
    });
    new CfnOutput(this, "TrustedSubject", {
      value: subject,
      description: "The sub claim this role accepts",
    });
  }
}
