#!/usr/bin/env bash
#
# scan-verdict.sh — renders the compliance verdict from synth evidence.
#
# THE single source of the verdict logic. Two jobs consume it:
#   - this repo's ci.yml `scan` job (block self-scan on every PR)
#   - up-platform's cdk-build.yml `scan` job (the real per-request gate)
# It used to be two hand-synced copies of the same script, which is the drift
# disease this project keeps killing elsewhere (the catalog's `version:` field,
# the wiki's shared gotchas).
#
# The verdict FAILS CLOSED: no synth log, no `compliance: pack=` line, or no
# validation report is "not verified", never a green tick. A clean cdk-nag run
# writes `pluginReports: []`, naming nothing it checked — with no plugin
# registered the report is not written at all, so DELETION is detectable, but
# SUBSTITUTION is not; the pack line printed by the block itself is what closes
# that gap.
#
# TWO channels are read, because there are two. cdk-nag reports through
# `validation-report.json`; CDK ITSELF reports through the cloud assembly's metadata,
# as `aws:cdk:warning` and `aws:cdk:error`. Until 2026-08-01 nothing here looked at the
# second one, so a run could be `compliant` while CDK was saying the resource does not
# do what its template claims — which is precisely what happened: `Unable to add
# necessary logging permissions to imported target bucket` sat in a green run's
# synth.log, unread by any gate. Same lesson as the pack line: a verdict that names
# only what it checked is not a verdict.
#
# Usage: scripts/scan-verdict.sh <cdk-out-dir> <synth-log>
#
# Optional env, used only to label the summary table:
#   SCAN_BLOCK  SCAN_SOURCE  SCAN_APP_ID  SCAN_ENVIRONMENT  SCAN_BUILD_RESULT
# Writes the panel to $GITHUB_STEP_SUMMARY when set (falls back to stdout),
# exits 1 unless the verdict is compliant.

set -euo pipefail

CDK_OUT="${1:?usage: scan-verdict.sh <cdk-out-dir> <synth-log>}"
LOG="${2:?usage: scan-verdict.sh <cdk-out-dir> <synth-log>}"
REPORT="$CDK_OUT/validation-report.json"

verdict="compliant"
detail=""

# 1. The control must be PROVABLE — the pack line is the only positive evidence.
if [ ! -f "$LOG" ] || ! grep -q "^compliance: pack=" "$LOG"; then
  verdict="not verified"
  detail="No \`compliance: pack=\` line — cannot prove a rule pack ran."
# 2. The report must EXIST. Absent means the synth died before validation.
elif [ ! -f "$REPORT" ]; then
  verdict="not verified"
  detail="No validation report — the synth did not reach the validation stage."
# 3. Any violation at any severity. cdk-nag v3 fails synth on warnings too, so
#    this agrees with the synth rather than second-guessing it.
elif [ "$(jq '[.pluginReports[].violations[]] | length' "$REPORT")" -gt 0 ]; then
  verdict="violations"
  detail="$(jq -r '.pluginReports[].violations[] | "- `\(.ruleName)` [\(.severity)] — \(.description)"' "$REPORT")"
fi

# ── CDK's own annotations ────────────────────────────────────────────────────
# Read from the ASSEMBLY, never from the log. The metadata is keyed by construct path
# and carries the acknowledgement id; the log carries prose whose shape changes between
# CDK versions, and grepping `^WARNING` would make the gate a text-matching exercise.
#
# Both assembly layouts are read. Recent CDK writes one `<Stack>.metadata.json` per
# artifact and points at it from `manifest.json` (`additionalMetadataFile`); older
# assemblies inline the same map under `.artifacts[].metadata`. Blocks travel to clients
# who pin their own aws-cdk-lib, and a client on a version this script did not expect
# must not silently get an unchecked build.
#
# Acknowledging one of these is NOT the deal cdk-nag offers. `Annotations.acknowledgeWarning`
# accepts a message and DISCARDS it, then splices the entry out of the assembly — so an
# acknowledged annotation leaves no trace here, none in the template, and nothing readable
# from AWS, where a cdk-nag acknowledgement writes its id and its reason into template
# Metadata. Everything this section can see is therefore unacknowledged by construction,
# and an acknowledgement's only record is the line of source that made it.
# shellcheck disable=SC2016  # a jq program: $path is jq's variable, and expanding it
# in the shell is exactly what must NOT happen.
SELECT_ANNOTATIONS='
  .key as $path | .value[]
  | select(.type == "aws:cdk:error" or .type == "aws:cdk:warning")
  | "- `\(.type | ltrimstr("aws:cdk:"))` `\($path)` — \(.data)"'

annotations="$(
  {
    if compgen -G "$CDK_OUT/*.metadata.json" > /dev/null; then
      jq -r "to_entries[] | $SELECT_ANNOTATIONS" "$CDK_OUT"/*.metadata.json
    fi
    if [ -f "$CDK_OUT/manifest.json" ]; then
      jq -r ".artifacts // {} | to_entries[] | (.value.metadata // {}) | to_entries[] | $SELECT_ANNOTATIONS" \
        "$CDK_OUT/manifest.json"
    fi
  } | sort -u
)"

# Only ever tightens the verdict. A cdk-nag violation is the stronger signal and keeps
# its name; the annotations still render below either way.
if [ "$verdict" = "compliant" ]; then
  if [ -n "$annotations" ]; then
    verdict="annotations"
  elif [ ! -f "$CDK_OUT/manifest.json" ]; then
    # No manifest means the annotation channel could not be read at all, which is not
    # the same fact as "there were none".
    verdict="not verified"
    detail="No \`manifest.json\` — cannot read CDK's own annotation channel."
  else
    # A manifest that points at a metadata file which is not there: the artifact was
    # truncated, or the download half-failed. Silence from a file that should exist is
    # the substitution case, so it fails rather than reporting a clean sweep.
    missing="$(jq -r '.artifacts // {} | to_entries[]
                      | select(.value.additionalMetadataFile)
                      | .value.additionalMetadataFile' "$CDK_OUT/manifest.json" \
               | while read -r f; do [ -f "$CDK_OUT/$f" ] || echo "- \`$f\`"; done)"
    if [ -n "$missing" ]; then
      verdict="not verified"
      detail="\`manifest.json\` declares metadata files that are absent:"$'\n'"$missing"
    fi
  fi
fi

{
  echo "### Compliance scan"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "| verdict | **$verdict** |"
  echo "| block | \`${SCAN_BLOCK:-unknown}\` |"
  echo "| source | \`${SCAN_SOURCE:-unknown}\` |"
  echo "| appId | \`${SCAN_APP_ID:-n/a}\` |"
  echo "| environment | \`${SCAN_ENVIRONMENT:-n/a}\` |"
  echo "| build | \`${SCAN_BUILD_RESULT:-n/a}\` |"
  echo ""
  echo "#### Rule pack"
  echo ""
  echo '```'
  grep -h "^compliance: " "$LOG" 2>/dev/null || echo "none recorded"
  echo '```'
  echo ""
  if [ -n "$detail" ]; then
    echo "#### Findings"
    echo ""
    echo "$detail"
    echo ""
  fi
  # Always rendered, even when empty. "none" is a claim the panel is now entitled to
  # make; before this section it was making that claim by saying nothing.
  echo "#### CDK annotations"
  echo ""
  if [ -n "$annotations" ]; then
    echo "$annotations"
  else
    echo "- none"
  fi
  echo ""
  echo "#### Exceptions in force"
  echo ""
  if compgen -G "$CDK_OUT/*.template.json" > /dev/null; then
    jq -r '.Resources | to_entries[]
           | select(.value.Metadata.cdk_nag)
           | .value.Metadata.cdk_nag.rules_to_suppress[]
           | "- `\(.id)` — \(.reason)"' "$CDK_OUT"/*.template.json \
      | sort -u | grep . || echo "- none"
  else
    echo "- no template emitted"
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ "$verdict" != "compliant" ]; then
  echo "::error::Compliance scan: $verdict"
  exit 1
fi
echo "compliant — no violations, pack execution verified"
