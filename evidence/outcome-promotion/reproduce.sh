#!/usr/bin/env bash
# Reproduce evidence/outcome-promotion/ from the repository, end to end.
#
#   pnpm build && bash evidence/outcome-promotion/reproduce.sh
#
# Run from the repository root. Every command below is the shipped `crr` binary against the
# shipped fixture on an ephemeral loopback port. NOTHING HERE REACHES A MODEL: `crr` has no
# discovery verb, and the whole promotion path runs with zero credentials - which is why the
# script unsets every provider variable before each call rather than trusting the environment.
#
# WHAT IS NOT REPRODUCED BYTE FOR BYTE, and it is more than you would guess. Run ids are random
# and timestamps are wall-clock. An observation's CONTENT ADDRESS is not stable either: it covers
# the driver-assigned `stability.generation`, which counts repaints and therefore depends on
# timing, so the same screen freezes to a different digest on the next run. That is the measured
# fact `packages/core/src/promotion.ts` already records - the same application-error screen
# produced four different digests across five `pnpm demo` runs - and it is exactly why the review
# document below is BUILT FROM THE RUN JOURNAL rather than frozen by hand: a hand-written digest
# would be stale the moment anybody re-ran the probe. Everything downstream of the review - the
# review digest, artifact@2's digest, the signature - therefore differs between runs too. The
# approver key pair is generated per run on purpose: a private key in a repository is a private
# key on the internet.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
HERE=evidence/outcome-promotion
LIVE=evidence/discovery-live/synthesized
CRR=(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN node packages/runtime/dist/cli.js)
SURFACE=packages/runtime/demo/surface-entry.mjs
KEY_ID=crr-outcome-review-key-1
TENANT=riverbend
APP=riverbend-corebank-live

# The three caller arguments. Every one is an invented member number in the fixture's 100xx block
# (fixtures/corebank-web/src/data.js), and none of them is one of the values `pnpm demo`'s
# whole-bundle canary searches for - the same reason the live discovery run picked its own.
GREEN_MEMBER=10043       # on file: the member the live discovery run was recorded against.
ABSENT_MEMBER=10099      # well-formed and not on file: the outcome this exercise promotes.
MALFORMED_MEMBER=7777    # not five digits: the application's own validation banner.

say() { printf '\n=== %s\n' "$1"; }

# ---------------------------------------------------------------------------------------------
say "0. a fresh approver key pair, outside the repository"
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const pair = generateKeyPairSync("ed25519");
writeFileSync(process.argv[1] + "/reviewer.pkcs8.pem", pair.privateKey.export({ format: "pem", type: "pkcs8" }));
writeFileSync(process.argv[2], pair.publicKey.export({ format: "pem", type: "spki" }));
' "$KEYDIR" "$HERE/keys/reviewer.spki.pem"
SIGN="$KEY_ID:$KEYDIR/reviewer.pkcs8.pem"
TRUST="$KEY_ID:$HERE/keys/reviewer.spki.pem"

say "1. the documents as the live discovery run left them"
rm -rf "$HERE"/{before,probe-green,probe-absent,probe-app-error,probe-session-expired,probe-validation-error,probe-interstitial,invocation-before,invocation-after-outcome,invocation-after-green,promoted,verified,approved,confirm}
rm -f "$HERE"/review/promotion.json "$HERE"/review/promotion-attempt-1-refused.json "$HERE"/review/promote-attempt-1-refused.txt "$HERE"/link.txt
mkdir -p "$HERE/before"
cp "$LIVE/contract.json" "$HERE/before/contract.json"
cp "$LIVE/artifact.json" "$HERE/before/artifact.json"

say "2. approve a COPY of v1, because crr probe and crr replay run approved artifacts (check 27)"
"${CRR[@]}" approve "$HERE/before/artifact.json" \
  --sign-key "$SIGN" --approver "approver:agent-acting-as-approver" \
  --ack-grade full --ack-effects WRITE_REVERSIBLE \
  --out "$HERE/before/artifact-approved-for-probe.json" | tee "$HERE/before/approve-console.txt"

V1="$HERE/before/artifact-approved-for-probe.json"
C1="$HERE/before/contract.json"

# One probe. `--capture-every` freezes a screen at every step whatever the steps declare, which is
# the only way a GREEN run leaves anything behind: every step of this artifact says
# `captureOn: ["failure"]`.
probe() { # <dir> <member> [fault]
  local dir="$HERE/$1" member="$2" fault="${3:-}"
  mkdir -p "$dir"
  CRR_DEMO_ARTIFACT="$HERE/before/artifact.json" CRR_DEMO_FAULT="$fault" \
  "${CRR[@]}" probe "$C1" "$V1" --surface "$SURFACE" \
    --args "{\"memberId\":\"$member\"}" --tenant "$TENANT" --app "$APP" \
    --trusted-key "$TRUST" --journal "$dir/journal.jsonl" --evidence "$dir/observations" \
    > "$dir/console.txt" 2>&1
  printf '  %-26s exit %s\n' "$1" "$?"
  cat "$dir/console.txt"
}

say "3. the corpus: one green run, one that meets the condition, four that meet other conditions"
probe probe-green            "$GREEN_MEMBER"
probe probe-absent           "$ABSENT_MEMBER"
probe probe-app-error        "$GREEN_MEMBER" 'set=app-error&at=results&mode=sticky'
probe probe-session-expired  "$GREEN_MEMBER" 'set=session-timeout&at=results&mode=sticky'
probe probe-interstitial     "$GREEN_MEMBER" 'set=interstitial&at=results&mode=sticky'
probe probe-validation-error "$MALFORMED_MEMBER"

say "4. BEFORE: invoke v1 against a member that does not exist"
mkdir -p "$HERE/invocation-before"
CRR_DEMO_ARTIFACT="$HERE/before/artifact.json" \
"${CRR[@]}" replay "$C1" "$V1" --surface "$SURFACE" \
  --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --tenant "$TENANT" --app "$APP" \
  --trusted-key "$TRUST" --journal "$HERE/invocation-before/journal.jsonl" \
  --evidence "$HERE/invocation-before/observations" --json > "$HERE/invocation-before/result.json"
echo "  exit $? (1 = hard failure)"
node -e 'const r=require("node:fs").readFileSync(process.argv[1],"utf8");const j=JSON.parse(r);console.log("  arm",j.status,"-",j.failure.class,"at",j.failure.atStep)' "$HERE/invocation-before/result.json"

CORPUS_A=(--corpus "$HERE/probe-green" --corpus "$HERE/probe-absent" --corpus "$HERE/probe-app-error" --corpus "$HERE/probe-session-expired" --corpus "$HERE/probe-interstitial" --corpus "$HERE/probe-validation-error")
CORPUS_B=(--corpus "$HERE/probe-green" --corpus "$HERE/probe-app-error" --corpus "$HERE/probe-session-expired" --corpus "$HERE/probe-interstitial" --corpus "$HERE/probe-validation-error" --corpus "$HERE/invocation-before")

say "5. the reviewer's FIRST attempt: the detector at activate-search. THE PROVER REFUSES."
node "$HERE/review/build-review.mjs" "$HERE/probe-absent/journal.jsonl" activate-search \
  "$HERE/review/promotion-attempt-1-refused.json" \
  "$HERE/probe-green" "$HERE/probe-absent" "$HERE/probe-app-error" "$HERE/probe-session-expired" "$HERE/probe-interstitial" "$HERE/probe-validation-error"
"${CRR[@]}" promote "$C1" "$HERE/before/artifact.json" \
  --review "$HERE/review/promotion-attempt-1-refused.json" "${CORPUS_A[@]}" \
  --tenant "$TENANT" --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --dry-run \
  > "$HERE/review/promote-attempt-1-refused.txt" 2>&1
echo "  exit $? (1 = refused)"
cat "$HERE/review/promote-attempt-1-refused.txt"

say "6. the reviewer's SECOND attempt: the detector at the step the run actually stopped at"
node "$HERE/review/build-review.mjs" "$HERE/invocation-before/journal.jsonl" read-membername-sharebalance-membershipstatus \
  "$HERE/review/promotion.json" \
  "$HERE/probe-green" "$HERE/probe-app-error" "$HERE/probe-session-expired" "$HERE/probe-interstitial" "$HERE/probe-validation-error" "$HERE/invocation-before"
mkdir -p "$HERE/promoted"
"${CRR[@]}" promote "$C1" "$HERE/before/artifact.json" \
  --review "$HERE/review/promotion.json" "${CORPUS_B[@]}" \
  --tenant "$TENANT" --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --dry-run \
  > "$HERE/promoted/console-dry-run.txt" 2>&1
echo "  dry run exit $?"
cat "$HERE/promoted/console-dry-run.txt"

say "7. the promotion, for real: contract@2.0.0 + artifact@2 (proposed)"
"${CRR[@]}" promote "$C1" "$HERE/before/artifact.json" \
  --review "$HERE/review/promotion.json" "${CORPUS_B[@]}" \
  --tenant "$TENANT" --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --out-dir "$HERE/promoted" \
  > "$HERE/promoted/console.txt" 2>&1
echo "  exit $?"
cat "$HERE/promoted/console.txt"

C2="$HERE/promoted/contract.json"

say "8. the second gate: re-verify v2 with the model out of the loop"
mkdir -p "$HERE/verified"
CRR_DEMO_ARTIFACT="$HERE/promoted/artifact.json" \
"${CRR[@]}" verify "$C2" "$HERE/promoted/artifact.json" --surface "$SURFACE" \
  --args "{\"memberId\":\"$GREEN_MEMBER\"}" --tenant "$TENANT" --app "$APP" \
  --allowlist "$HERE/allowlist.json" --journal "$HERE/verified/journal.jsonl" \
  --evidence "$HERE/verified/observations" --out "$HERE/verified/artifact.json" \
  > "$HERE/verified/console.txt" 2>&1
echo "  exit $?"
cat "$HERE/verified/console.txt"

say "9. a person signs it, ticking the reviewer-authored outcome by hand"
mkdir -p "$HERE/approved"
"${CRR[@]}" approve "$HERE/verified/artifact.json" \
  --sign-key "$SIGN" --approver "approver:agent-acting-as-approver" \
  --ack-grade full --ack-effects WRITE_REVERSIBLE --ack-promotions MEMBER_NOT_FOUND \
  --out "$HERE/approved/artifact.json" > "$HERE/approved/console.txt" 2>&1
echo "  exit $?"
cat "$HERE/approved/console.txt"

V2="$HERE/approved/artifact.json"

say "10. AFTER: invoke v2 against the member that does not exist"
mkdir -p "$HERE/invocation-after-outcome"
CRR_DEMO_ARTIFACT="$V2" \
"${CRR[@]}" replay "$C2" "$V2" --surface "$SURFACE" \
  --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --tenant "$TENANT" --app "$APP" \
  --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" \
  --journal "$HERE/invocation-after-outcome/journal.jsonl" \
  --evidence "$HERE/invocation-after-outcome/observations" \
  > "$HERE/invocation-after-outcome/console.txt" 2>&1
echo "  exit $? (2 = a business outcome, which is not an error)"
cat "$HERE/invocation-after-outcome/console.txt"

say "11. and against a member that does exist, so the detector has not hijacked the happy path"
mkdir -p "$HERE/invocation-after-green"
CRR_DEMO_ARTIFACT="$V2" \
"${CRR[@]}" replay "$C2" "$V2" --surface "$SURFACE" \
  --args "{\"memberId\":\"$GREEN_MEMBER\"}" --tenant "$TENANT" --app "$APP" \
  --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" \
  --journal "$HERE/invocation-after-green/journal.jsonl" \
  --evidence "$HERE/invocation-after-green/observations" \
  > "$HERE/invocation-after-green/console.txt" 2>&1
echo "  exit $? (0 = ok)"
cat "$HERE/invocation-after-green/console.txt"

say "12. probeConfirmed: evidence, never a gate - and it must be stamped BEFORE the signature"
mkdir -p "$HERE/confirm"
CRR_DEMO_ARTIFACT="$V2" \
"${CRR[@]}" replay "$C2" "$V2" --surface "$SURFACE" \
  --args "{\"memberId\":\"$ABSENT_MEMBER\"}" --tenant "$TENANT" --app "$APP" \
  --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" \
  --journal "$HERE/confirm/journal.jsonl" --evidence "$HERE/confirm/observations" --json \
  > "$HERE/confirm/result.json"
echo "  probe run exit $?"
{
  echo '$ crr promote --confirm <the APPROVED revision> --code MEMBER_NOT_FOUND --result confirm/result.json'
  "${CRR[@]}" promote --confirm "$V2" --code MEMBER_NOT_FOUND --result "$HERE/confirm/result.json" --out /dev/null 2>&1
  echo "exit $?"
  echo
  echo '$ crr promote --confirm <the VERIFIED DRAFT> --code MEMBER_NOT_FOUND --result confirm/result.json --out confirm/artifact.json'
  "${CRR[@]}" promote --confirm "$HERE/verified/artifact.json" --code MEMBER_NOT_FOUND --result "$HERE/confirm/result.json" --out "$HERE/confirm/artifact.json" 2>&1
  echo "exit $?"
} > "$HERE/confirm/console.txt" 2>&1
cat "$HERE/confirm/console.txt"

say "13. re-sign the confirmed revision"
"${CRR[@]}" approve "$HERE/confirm/artifact.json" \
  --sign-key "$SIGN" --approver "approver:agent-acting-as-approver" \
  --ack-grade full --ack-effects WRITE_REVERSIBLE --ack-promotions MEMBER_NOT_FOUND \
  --out "$HERE/confirm/artifact-approved.json" > "$HERE/confirm/approve-console.txt" 2>&1
echo "  exit $?"
cat "$HERE/confirm/approve-console.txt"

say "14. the linker, before and after, and at a tenant nobody proved it at"
{
  echo '# 00000 is well formed and on file nowhere. `crr link` performs ZERO ACTIONS, so the'
  echo '# argument only has to satisfy check 28 - which is the point of running it before anything starts.'
  echo '$ crr link  before/contract.json  before/artifact-approved-for-probe.json  --args {"memberId":"00000"}  --tenant riverbend'
  "${CRR[@]}" link "$C1" "$V1" --args '{"memberId":"00000"}' --tenant "$TENANT" \
    --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" 2>&1
  echo "exit $?"
  echo
  echo '$ crr link  promoted/contract.json  confirm/artifact-approved.json  --tenant riverbend'
  "${CRR[@]}" link "$C2" "$HERE/confirm/artifact-approved.json" --args '{"memberId":"00000"}' --tenant "$TENANT" \
    --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" 2>&1
  echo "exit $?"
  echo
  echo '$ crr link  promoted/contract.json  confirm/artifact-approved.json  --tenant summit'
  "${CRR[@]}" link "$C2" "$HERE/confirm/artifact-approved.json" --args '{"memberId":"00000"}' --tenant summit \
    --allowlist "$HERE/allowlist.json" --trusted-key "$TRUST" 2>&1
  echo "exit $?"
} > "$HERE/link.txt" 2>&1
cat "$HERE/link.txt"

say "15. the redaction canary over everything this script wrote"
node "$HERE/canary/run-canary.mjs"
echo "  canary exit $?"
