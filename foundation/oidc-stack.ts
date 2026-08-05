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
  /** The platform repo — the repo that OWNS the workflows allowed to reach this account. */
  readonly githubRepo: string;
  /**
   * LEGACY. The branch whose runs may assume the role, under GitHub's DEFAULT `sub`
   * template. Removed once every caller presents a `job_workflow_ref` subject — see
   * `trustedWorkflows`.
   */
  readonly githubBranch: string;
  /**
   * The workflow FILES whose runs may assume this role, under a CUSTOMIZED `sub` template
   * (`include_claim_keys: [repository_owner, job_workflow_ref]`). Bare filenames, e.g.
   * `["app-plan.yml", "app-apply.yml"]`. One IAM statement each.
   *
   * Absent or empty means legacy-only trust, which is what makes adding this an additive,
   * inspectable no-op: nothing presents these subjects until the template is flipped.
   */
  readonly trustedWorkflows?: readonly string[];
  /**
   * The ref those workflow files must be called at, as a full ref
   * (`refs/heads/main`, `refs/tags/v1`). Defaults to `refs/heads/<githubBranch>`.
   */
  readonly platformRef?: string;
  /**
   * Whether the role still trusts the two PLACE-shaped subjects
   * (`ref:refs/heads/<branch>` and `pull_request`).
   *
   * Default true, because dropping them is the SUBTRACTIVE half of a cutover whose rule
   * is additive first, subtractive last: they must survive until every caller presents a
   * `job_workflow_ref` subject — measured, not assumed, because a repo-level
   * `use_default: true` silently overrides the org template (found 2026-08-05, in
   * CloudTrail, after the org flip changed nothing).
   *
   * Setting this false with no `trustedWorkflows` would synthesize a role nothing can
   * assume; the entrypoint refuses the combination.
   */
  readonly legacySubjects?: boolean;
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
     * The claims that decide everything.
     *
     * Two SHAPES of subject live here at once, on purpose, because a `sub` template is
     * flipped instantaneously and org-wide while an IAM change is a deploy. Additive
     * first, subtractive last: the new subjects are added while nothing presents them,
     * the template is flipped, and only then are the legacy two removed.
     *
     * ── LEGACY: the subject names a PLACE ────────────────────────────────────────────
     *
     * - `ref:refs/heads/<branch>` — execute on main.
     * - `pull_request` — the jobs that create the change set an approver reads.
     *
     * Both are repo-wide, and that is a hole rather than a nuance: `…:pull_request` is
     * presented by ANY `pull_request`-triggered workflow in the repo, INCLUDING a workflow
     * file added by that same pull request, on its first run, before a human reads it.
     * Whoever can open a PR can reach the bootstrap chain, whose execution policy is
     * `AdministratorAccess`. It is the pwn-request pattern wearing a quieter costume:
     * nobody flags `pull_request` (as opposed to `pull_request_target`) because the code is
     * "only" the PR's own — but the OIDC subject does not make that distinction.
     *
     * ── NEW: the subject names CODE ──────────────────────────────────────────────────
     *
     * Under a customized `sub` template (`include_claim_keys:
     * [repository_owner, job_workflow_ref]`) the subject stops naming the calling repo and
     * names the workflow FILE instead:
     *
     *   repository_owner:<org>:job_workflow_ref:<org>/<repo>/.github/workflows/<file>@<ref>
     *
     * MEASURED, not inferred — one run, two jobs, same repository
     * (`up-deploy/probe-app` run 30949963157, 2026-08-04):
     *
     *   the repo's OWN workflow  → …job_workflow_ref:up-deploy/probe-app/…/probe.yml@…
     *   the PLATFORM's reusable  → …job_workflow_ref:up-deploy/up-platform/…/probe-reusable.yml@…
     *
     * Two different subjects from one repository in one run. Pinning the second admits the
     * platform's workflow and refuses a workflow the calling team wrote, which is the whole
     * security argument and the thing the legacy shape cannot express.
     *
     * Note what does NOT appear: the calling repository. So this admits any repo in the org
     * WITHOUT a wildcard and without an IAM statement per app — and it is a different claim
     * from the org-wide `repo:<org>/*` subject rejected on 2026-07-29, which widened *who*
     * rather than pinning *what code*.
     *
     * The honest limit still stands and is unchanged by any of this: the platform repo has
     * no branch protection on a Free plan, so "at `refs/heads/main`" means "whatever reached
     * main". This bounds which workflow context can reach AWS. It is not a review gate.
     */
    const subjectBranch = `repo:${props.githubOrg}/${props.githubRepo}:ref:refs/heads/${props.githubBranch}`;
    const subjectPullRequest = `repo:${props.githubOrg}/${props.githubRepo}:pull_request`;
    const legacySubjects = props.legacySubjects ?? true;

    const platformRef = props.platformRef ?? `refs/heads/${props.githubBranch}`;
    const workflowSubjects = (props.trustedWorkflows ?? []).map(
      (workflow) =>
        `repository_owner:${props.githubOrg}` +
        `:job_workflow_ref:${props.githubOrg}/${props.githubRepo}` +
        `/.github/workflows/${workflow}@${platformRef}`,
    );

    const subjects = [
      ...(legacySubjects ? [subjectBranch, subjectPullRequest] : []),
      ...workflowSubjects,
    ];

    // Belt to the entrypoint's braces: a role with an empty trust is not "locked down",
    // it is a deploy that leaves CI unable to deploy anything ever again, discovered at
    // the next request. Refused here too in case a future caller skips the entrypoint.
    if (subjects.length === 0) {
      throw new Error(
        "OidcFoundationStack: legacySubjects=false with no trustedWorkflows leaves no subject at all — nothing could ever assume the role.",
      );
    }

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: `UppDeployRole-${props.environment}`,
      description:
        `Assumed by GitHub Actions from ${props.githubOrg}/${props.githubRepo} ` +
        `on ${props.githubBranch} or pull_request (plan change sets)` +
        (workflowSubjects.length
          ? `, and by ${props.trustedWorkflows?.join(", ")} at ${platformRef} from any repo in the org`
          : "") +
        `. Holds no deployment permissions of its own.`,
      // One statement per subject (CompositePrincipal), not an array under one
      // StringEquals: clearer audits, and it matches how IAM documents multi-subject OIDC
      // trusts. It also means the statement COUNT is an assertable fact — a workflow that
      // quietly inherits access shows up as an extra statement, and a test says so.
      assumedBy: new iam.CompositePrincipal(
        ...subjects.map(
          (sub) =>
            new iam.WebIdentityPrincipal(this.providerArn, {
              StringEquals: {
                [`${GITHUB_OIDC_HOST}:aud`]: STS_AUDIENCE,
                [`${GITHUB_OIDC_HOST}:sub`]: sub,
              },
            }),
        ),
      ),
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
      value: subjects.join(" | "),
      description:
        "Every sub claim this role accepts. Read it back after a deploy: this output is the " +
        "only place the trust is legible without parsing the policy document.",
    });
  }
}
