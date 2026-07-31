#!/usr/bin/env bash
#
# foundation-preflight.sh — reads the target AWS account and states what it found.
#
# The foundation is deployed by hand into an account this repo's author has never
# seen. Every other gate in this project checks something we wrote; this one checks
# the one input we cannot: somebody else's account.
#
# It exists because the failures it catches are SILENT. A bootstrap under a custom
# qualifier produces a foundation that deploys perfectly and grants assume on four
# roles that do not exist — the first symptom is an unrelated `AccessDenied` days
# later, naming nothing that leads back here. An OIDC provider that already exists
# fails the deploy outright, which is at least loud; one that exists WITHOUT
# `sts.amazonaws.com` in its client IDs is worse, because the trust policy reads
# perfectly and the token exchange fails at runtime.
#
# It REPORTS and does not prescribe. The CloudFormation execution policies are the
# operator's decision and their account's business — this prints what is in force so
# the choice is visible, and takes no view on it. Only facts that make the deploy
# provably wrong are hard stops.
#
# Read-only. Every call is a Describe/Get/List; nothing here changes anything.
#
# Usage: scripts/foundation-preflight.sh <aws-profile> <region> [deploy-role] [toolkit-stack-name]
#
# deploy-role is optional and names the role the foundation will CREATE (e.g. UppDeployRole-dev).
# Pass it and preflight refuses to proceed if that role already exists; omit it and that check
# is skipped rather than guessed.
#
# Exit 0 = ready to deploy, and the command to run is printed at the end.
# Exit 1 = a hard stop, with the remediation named.

set -euo pipefail

PROFILE="${1:?usage: foundation-preflight.sh <aws-profile> <region> [deploy-role] [toolkit-stack-name]}"
REGION="${2:?usage: foundation-preflight.sh <aws-profile> <region> [deploy-role] [toolkit-stack-name]}"
DEPLOY_ROLE="${3:-}"
TOOLKIT_STACK="${4:-CDKToolkit}"

# The stack name the foundation entrypoint deploys under.
FOUNDATION_STACK="Foundation"

# CDK's own thresholds, from aws-cdk-lib's DefaultStackSynthesizer. Below 6 the CLI
# refuses to deploy at all; below 8 there is no lookup role for it to use.
MIN_BOOTSTRAP_VERSION=6
MIN_LOOKUP_ROLE_VERSION=8

GITHUB_OIDC_HOST="token.actions.githubusercontent.com"
STS_AUDIENCE="sts.amazonaws.com"
DEFAULT_QUALIFIER="hnb659fds"

STOPS=()
NOTES=()

stop() { STOPS+=("$1"); }
note() { NOTES+=("$1"); }

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "preflight: profile=$PROFILE region=$REGION toolkit=$TOOLKIT_STACK"
echo

# ---------------------------------------------------------------------------
# 1. Who are we? Nothing below means anything without this.
# ---------------------------------------------------------------------------
if ! IDENTITY="$(aws_ sts get-caller-identity --output json 2>&1)"; then
  echo "FAILED to call AWS. Credentials are not usable:"
  echo "    ${IDENTITY//$'\n'/$'\n'    }"
  echo
  echo "verdict: NOT READY — no working credentials for profile '$PROFILE'."
  exit 1
fi
ACCOUNT="$(echo "$IDENTITY" | jq -r '.Account')"
CALLER_ARN="$(echo "$IDENTITY" | jq -r '.Arn')"

# ---------------------------------------------------------------------------
# 2. Is the account bootstrapped, and how?
# ---------------------------------------------------------------------------
QUALIFIER=""
EXEC_POLICIES=""
TRUSTED=""
TRUSTED_LOOKUP=""
STACK_VERSION=""
SSM_VERSION=""

if ! TOOLKIT="$(aws_ cloudformation describe-stacks --stack-name "$TOOLKIT_STACK" --output json 2>&1)"; then
  stop "Account $ACCOUNT is NOT bootstrapped in $REGION (no '$TOOLKIT_STACK' stack).
    Run:  npx cdk bootstrap aws://$ACCOUNT/$REGION --profile $PROFILE
    Choose --cloudformation-execution-policies deliberately; it governs every future deploy."
else
  param() {
    echo "$TOOLKIT" | jq -r --arg k "$1" \
      '.Stacks[0].Parameters[]? | select(.ParameterKey==$k) | .ParameterValue'
  }
  QUALIFIER="$(param Qualifier)"
  EXEC_POLICIES="$(param CloudFormationExecutionPolicies)"
  TRUSTED="$(param TrustedAccounts)"
  TRUSTED_LOOKUP="$(param TrustedAccountsForLookup)"
  STACK_VERSION="$(echo "$TOOLKIT" | jq -r \
    '.Stacks[0].Outputs[]? | select(.OutputKey=="BootstrapVersion") | .OutputValue')"
  QUALIFIER="${QUALIFIER:-$DEFAULT_QUALIFIER}"

  # The version the DEPLOY checks is the SSM parameter, not the stack output. CDK
  # bakes a CheckBootstrapVersion rule reading this exact path into every template,
  # so this is the number that decides whether a deploy is allowed to start.
  SSM_VERSION="$(aws_ ssm get-parameter --name "/cdk-bootstrap/$QUALIFIER/version" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo "")"

  if [ -z "$SSM_VERSION" ]; then
    stop "The bootstrap version parameter /cdk-bootstrap/$QUALIFIER/version is missing.
    The toolkit stack exists but the deploy-time version check cannot resolve — re-run cdk bootstrap."
  elif [ "$SSM_VERSION" -lt "$MIN_BOOTSTRAP_VERSION" ]; then
    stop "Bootstrap version $SSM_VERSION is below the minimum $MIN_BOOTSTRAP_VERSION.
    Re-run cdk bootstrap with a current CDK CLI."
  elif [ "$SSM_VERSION" -lt "$MIN_LOOKUP_ROLE_VERSION" ]; then
    note "Bootstrap version $SSM_VERSION has no lookup role (needs >= $MIN_LOOKUP_ROLE_VERSION); context lookups will fail."
  fi

  if [ -n "$STACK_VERSION" ] && [ -n "$SSM_VERSION" ] && [ "$STACK_VERSION" != "$SSM_VERSION" ]; then
    note "Stack output says version $STACK_VERSION but SSM says $SSM_VERSION — the deploy trusts SSM."
  fi

  # ------------------------------------------------------------------------
  # 3. Do the four roles the foundation grants assume on actually exist?
  #    This is the qualifier bug made visible: a name that is merely a string
  #    in a policy becomes an AccessDenied with no breadcrumb months later.
  # ------------------------------------------------------------------------
  for purpose in deploy file-publishing image-publishing lookup; do
    role="cdk-$QUALIFIER-$purpose-role-$ACCOUNT-$REGION"
    if ! aws_ iam get-role --role-name "$role" >/dev/null 2>&1; then
      stop "Bootstrap role missing: $role
    The foundation grants sts:AssumeRole on this exact name. Deploying without it
    produces a stack that succeeds and a permission that points at nothing."
    fi
  done
fi

# ---------------------------------------------------------------------------
# 4. Does a GitHub OIDC provider already exist?
#    AWS permits one per issuer per account, so this decides whether the
#    foundation creates it or references it.
# ---------------------------------------------------------------------------
EXISTING_PROVIDER="no"
PROVIDER_ARN="$(aws_ iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, '$GITHUB_OIDC_HOST')].Arn | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ -n "$PROVIDER_ARN" ] && [ "$PROVIDER_ARN" != "None" ]; then
  EXISTING_PROVIDER="yes"
  CLIENT_IDS="$(aws_ iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "$PROVIDER_ARN" \
    --query 'ClientIDList' --output json 2>/dev/null || echo '[]')"

  # The check this whole script justifies. The stack cannot see inside an existing
  # provider, so without this the deploy is green, the trust policy is textbook,
  # and the token exchange fails at runtime with nothing obviously wrong.
  if ! echo "$CLIENT_IDS" | jq -e --arg a "$STS_AUDIENCE" 'index($a)' >/dev/null 2>&1; then
    stop "The existing OIDC provider does NOT list '$STS_AUDIENCE' as a client ID.
    Its client IDs: $(echo "$CLIENT_IDS" | jq -c .)
    The role would deploy correctly and fail only when a workflow tries to use it. Fix:
    aws iam add-client-id-to-open-id-connect-provider --profile $PROFILE \\
      --open-id-connect-provider-arn $PROVIDER_ARN --client-id $STS_AUDIENCE"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Would this deploy collide with something already there?
#    Added 2026-07-31 after both had to be checked BY HAND before the first real
#    deploy. Either one fails the deploy with AlreadyExists once CloudFormation is
#    already running, which is the expensive moment to find out. `deployRole` is
#    optional: it names the role the foundation will create, and callers that do not
#    pass it simply skip this check rather than being refused.
# ---------------------------------------------------------------------------
# Stack first, because it decides how to read the role. A role that exists BECAUSE the
# foundation created it is not a collision, it is an update; a role that exists WITHOUT the
# stack is, and CloudFormation only discovers that partway through a create.
FOUNDATION_EXISTS="no"
if STACK_STATUS="$(aws_ cloudformation describe-stacks --stack-name "$FOUNDATION_STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"; then
  case "$STACK_STATUS" in
    ROLLBACK_COMPLETE|ROLLBACK_FAILED|CREATE_FAILED|DELETE_FAILED)
      stop "Stack '$FOUNDATION_STACK' exists in state $STACK_STATUS and cannot be updated.
    A stack left in this state has to be deleted before it can be created again."
      ;;
    *)
      FOUNDATION_EXISTS="yes"
      note "Stack '$FOUNDATION_STACK' already exists ($STACK_STATUS), so this run is an UPDATE, not a create."
      ;;
  esac
fi

if [ -n "$DEPLOY_ROLE" ] && aws_ iam get-role --role-name "$DEPLOY_ROLE" >/dev/null 2>&1; then
  if [ "$FOUNDATION_EXISTS" = "yes" ]; then
    note "Role $DEPLOY_ROLE exists and belongs to '$FOUNDATION_STACK'. Expected for an update."
  else
    stop "Role $DEPLOY_ROLE already exists, but stack '$FOUNDATION_STACK' does not.
    The foundation CREATES that role, so a create would fail with AlreadyExists partway through.
    Either it was deployed under a different stack name, or the name collides with an unrelated
    role. Check:  aws iam get-role --role-name $DEPLOY_ROLE --profile $PROFILE"
  fi
fi

# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------
echo "| check | found |"
echo "|---|---|"
echo "| account | \`$ACCOUNT\` |"
echo "| caller | \`$CALLER_ARN\` |"
echo "| region | \`$REGION\` |"
if [ -n "$QUALIFIER" ]; then
  echo "| bootstrap | \`$TOOLKIT_STACK\`, version \`${SSM_VERSION:-unknown}\` |"
  echo "| qualifier | \`$QUALIFIER\`$([ "$QUALIFIER" = "$DEFAULT_QUALIFIER" ] && echo " (default)" || echo " (**custom**)") |"
  echo "| execution policies | \`${EXEC_POLICIES:-none}\` |"
  echo "| trusted accounts | \`${TRUSTED:-none}\` |"
  echo "| trusted for lookup | \`${TRUSTED_LOOKUP:-none}\` |"
else
  echo "| bootstrap | **absent** |"
fi
echo "| github oidc provider | $([ "$EXISTING_PROVIDER" = yes ] && echo "**already exists** — \`$PROVIDER_ARN\`" || echo "none — will be created") |"
echo

# The execution policies decide what every future deploy is allowed to do, so they
# are stated plainly rather than judged. An operator who sees AdministratorAccess
# here and is content with it has made a decision; one who never saw it has not.
if [ -n "$EXEC_POLICIES" ]; then
  echo "note: every CDK deploy in $ACCOUNT/$REGION runs as: $EXEC_POLICIES"
  echo "      (set at bootstrap time, shared by every stack, changed only by re-running cdk bootstrap)"
  echo
fi

if [ "${#NOTES[@]}" -gt 0 ]; then
  echo "notes:"
  for n in "${NOTES[@]}"; do echo "  - $n"; done
  echo
fi

if [ "${#STOPS[@]}" -gt 0 ]; then
  echo "verdict: NOT READY"
  for s in "${STOPS[@]}"; do echo "  ✗ $s"; done
  exit 1
fi

# ---------------------------------------------------------------------------
# Ready — print the command, with the flags this account actually needs.
# ---------------------------------------------------------------------------
echo "verdict: READY"
echo

# Only the flags THIS account needs. A downloader who never hits a custom qualifier
# never sees that flag, and one who does gets it filled in rather than explained.
EXTRA=""
if [ "$QUALIFIER" != "$DEFAULT_QUALIFIER" ]; then
  EXTRA="$EXTRA -c @aws-cdk/core:bootstrapQualifier=$QUALIFIER"
fi
if [ "$EXISTING_PROVIDER" = "yes" ]; then
  EXTRA="$EXTRA -c existingOidcProvider=true"
fi

echo "Deploy with:"
echo
echo "  npx cdk deploy -a \"npx ts-node foundation/oidc.ts\" \\"
echo "    --profile $PROFILE \\"
echo "    -c account=$ACCOUNT -c region=$REGION -c companyId=<companyId> -c env=<env> \\"
echo "    -c blockRef=<ref> -c tags='{}' \\"
if [ -n "$EXTRA" ]; then
  echo "    -c githubOrg=<org> -c githubRepo=<repo> -c githubBranch=<branch> \\"
  echo "   $EXTRA"
else
  echo "    -c githubOrg=<org> -c githubRepo=<repo> -c githubBranch=<branch>"
fi
