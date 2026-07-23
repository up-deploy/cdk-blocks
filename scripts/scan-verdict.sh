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
