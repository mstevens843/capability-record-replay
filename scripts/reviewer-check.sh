#!/usr/bin/env bash
set -euo pipefail

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN

echo "== typecheck =="
pnpm -F @crr/core typecheck
pnpm -F @crr/runtime typecheck
pnpm -F @crr/conformance typecheck

echo "== focused tests =="
pnpm -F @crr/runtime test escalation.test.ts
pnpm -F @crr/runtime test write-boundary.test.ts browser-write.test.ts demo-contract.test.ts
pnpm -F @crr/runtime test browser-overlay.test.ts
pnpm -F @crr/conformance test terminal-conformance.test.ts

echo "== supplemental evidence =="
pnpm -F @crr/runtime exec tsx demo/write-boundary.ts
pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts
pnpm -F @crr/runtime exec tsx demo/handoff.ts
pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts
pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts

echo "== main demo =="
pnpm demo

echo "== redaction grep =="
set +e
rg -n '\b10041\b|\b250\.00\b|\b50001\b' evidence
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "redaction grep found a literal sensitive demo value" >&2
  exit 1
fi
if [ "$status" -gt 1 ]; then
  echo "redaction grep failed with status $status" >&2
  exit "$status"
fi
echo "deterministic replay/supplemental redaction grep clean (rg exit 1 means no matches)"

set +e
rg -n '\b10043\b' evidence --glob '!evidence/discovery-live/**' --glob '!evidence/outcome-promotion/**'
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "member 10043 appeared outside the live discovery and outcome-promotion scopes" >&2
  exit 1
fi
if [ "$status" -gt 1 ]; then
  echo "scoped live-member redaction grep failed with status $status" >&2
  exit "$status"
fi
echo "live discovery member grep clean outside its documented scopes"

echo "== evidence paths =="
echo "evidence/write-boundary/"
echo "evidence/semantic-denials/"
echo "evidence/handoff/"
echo "evidence/multi-tenant-overlay/"
echo "evidence/terminal-survivors/"
echo "evidence/redaction-canary/"
