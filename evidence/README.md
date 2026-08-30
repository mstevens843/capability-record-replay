# `/evidence` - what was actually run, and what was not

This directory now has two kinds of evidence. The main replay bundle is produced by `pnpm demo`,
on a laptop, with no live service of any kind. Supplemental exhibits are produced by their own
commands and describe themselves in their own `README.md` files. `discovery-live/` is the only
model-produced directory when present. Everything else is deterministic replay, verification,
conformance, or promotion work.

**All data is synthetic.** `fixtures/corebank-web` is a purpose-built hostile back office; the
members, balances and account numbers in it exist nowhere else and are marked `(SYNTHETIC)` on
the screens themselves. No real PII and no real credential appears in this repository.

## The live discovery run

[`discovery-live/`](discovery-live/) holds a real one, produced by `pnpm discover --yes`.
It is the only thing in this bundle a model produced; read its own `README.md` and
`provenance.json` for the adapter, the model id, the measured token usage and the measured
spend. Everything else below is a **replay**, which is the half that runs in production
with no model in the decision path.

## Provenance - which adapter produced what

| Directory | Produced by | Model |
|---|---|---|
| [`artifact/`](artifact/) | hand-authored for build unit 11's acceptance test | **none** |
| `replay-0*/` | `@crr/runtime` `replay()` over `@crr/surface-browser` | **none - no model is in the decision path of a replay, by design** |
| [`cli-replay/`](cli-replay/) | the shipped `crr` binary | **none** |
| [`masked-capture/`](masked-capture/) | `@crr/surface-browser` `capture()` | **none** |
| [`redaction-canary/`](redaction-canary/) | `@crr/runtime` `runRedactionCanary()` | **none** |
| [`outcome-promotion/`](outcome-promotion/) | a reviewer walking the live artifact through `crr probe` / `crr promote` / `crr verify` | **none - the two documents it starts from came from the live run; nothing else here did** |
| [`write-boundary/`](write-boundary/) | `pnpm -F @crr/runtime exec tsx demo/write-boundary.ts` | **none** |
| [`semantic-denials/`](semantic-denials/) | `pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts` | **none** |
| [`handoff/`](handoff/) | `pnpm -F @crr/runtime exec tsx demo/handoff.ts` | **none** |
| [`multi-tenant-overlay/`](multi-tenant-overlay/) | `pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts` | **none** |
| [`terminal-survivors/`](terminal-survivors/) | `pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts` | **none** |
| [`discovery-live/`](discovery-live/) | `pnpm discover` - the `anthropic` adapter against the Messages API | see `discovery-live/provenance.json` |

### About `artifact/`

`artifact/artifact.json` was **hand-authored**, not synthesized from a discovery run, and its
`provenance.model.adapter` says `replay` with a model id of `none:hand-authored-for-unit-11`
because that enum has no honest value for "a person wrote this". Every matcher in it was derived
from a real `perceive()` over the fixture through `@crr/surface-browser` - none of it was written
by reading the fixture's HTML - but a model did not produce it and this bundle does not pretend
one did.

The live run did not replace this pinned artifact, on purpose. A synthesized artifact is the
**output** of a run and moves whenever the run is repeated. The suite that polices this bundle needs
an input it can pin. There are two synthesized artifacts, and neither is presented as this one. The
live run's artifact is committed beside its recording at
[`discovery-live/synthesized/artifact.json`](discovery-live/synthesized/artifact.json) and
was replayed by that run itself, with the model out of the loop, at
[`discovery-live/verification.json`](discovery-live/verification.json). A second, frozen one
lives at `packages/discovery/test/fixtures/corebank-web.capability.json`, and
`packages/runtime/test/synthesized-replay.test.ts` reads it off disk as data and replays it
against this same fixture on every `pnpm test` - which is the claim a reviewer can rerun.

The ed25519 approval key pair is generated per process, so `approver.spki.pem` and the signature
inside `artifact.json` differ on every demo run. The **digest** they sign does not: it is over
the JCS form of the document with `lifecycle` excluded, which is what makes an approved artifact
uneditable.

## The runs

| Directory | Taxonomy | Arm | What happened |
|---|---|---|---|
| [`replay-01-green/`](replay-01-green/) | green | `ok` | the nine-step share-position flow, no fault armed |
| [`replay-02-outcome-member-not-found/`](replay-02-outcome-member-not-found/) | expected business outcome | `outcome` | the core holds no such member |
| [`replay-03-recovered-interstitial/`](replay-03-recovered-interstitial/) | recoverable condition | `ok` | a declared maintenance modal, dismissed inside its budget |
| [`replay-04-failed-app-error/`](replay-04-failed-app-error/) | hard failure | `failed` | an application error page that will not clear |
| [`replay-05-failed-session-expired/`](replay-05-failed-session-expired/) | hard failure | `failed` | the session expires mid-flow and cannot be re-established |
| [`masked-capture/`](masked-capture/) | safety | masked | a screenshot region bound to a sensitive parameter, blanked before the bytes left the driver |
| [`cli-replay/`](cli-replay/) | reproducibility | exit 0 | the same replay through the shipped `crr` command, so a reviewer can run it verbatim |

Four of the five replays hit an exceptional state, and they fall into three different categories:
an expected business outcome, a recoverable condition, and two hard failures. That split matters:
`MEMBER_NOT_FOUND` is a typed **answer** the caller acts on, an interstitial is a
**bounded, budgeted, reported** remedy, and an application error page is a **stop** that names the
step, the expectation and the observation.

Each scenario directory holds `result.json` (what the calling agent receives), `journal.jsonl`
(the structured journal, written as the run happened), `run.log` (that scenario's console
output) and `observations/` - the run's evidence sink, holding content-addressed frozen
`Observation`s (each already through `redactObservation`) plus the journal blob the run's
`journalRef` points at. A green run freezes no observation, because these steps declare
`captureOn: ["failure"]`; the two hard failures each freeze the screen that failed, and that
file is a `classify()` unit test with no reproduction step attached to it.

## What the main `pnpm demo` bundle does not contain

`pnpm demo` is still the read/replay bundle. It does not post a sub-account, and it does not arm
commit-route permission faults. Those are covered by supplemental exhibits instead:

- `write-boundary/` covers approval refusal, dry-run boundary reporting, valid approval,
  rejected approvals, policy refusal, idempotency repeat, and effect-in-doubt.
- `semantic-denials/` covers record-denial business outcome vs role-denial entitlement failure
  against the browser write fixture.
- `handoff/` covers suspend, intervention context, same-session lease claim, policy-checked
  human action, safe handback and refused handback.
- `multi-tenant-overlay/` covers one base browser artifact running at a second tenant through
  overlay-only vocabulary, route and wait-budget changes, plus a no-overlay negative control.
- `terminal-survivors/` covers the green-screen mutant survivor ledger.

`pnpm demo` includes these supplemental directories when they already exist; the commands
above regenerate them explicitly.

## The redaction canary

`pnpm demo` finishes by grepping this entire directory for **every parameter value the runs
were given**, in fourteen encodings - the literal, UTF-16LE, JSON `\uXXXX`, percent-encoded,
HTML entities, hex, and base64 at all three byte alignments - plus the inflated text chunks of
any PNG, and every file NAME.

Where a needle could not be built, the report says so rather than omitting it: a five-digit member number
is eight base64 characters, of which only three to five are independent of the value's byte
alignment, which is too few to tell from noise. Those pairs are listed under `not searched` in
[`redaction-canary/report.txt`](redaction-canary/report.txt). An encoding that was never searched
for is not coverage, and a report that quietly dropped it would be claiming more than it checked.

Result of the run that produced the main demo bundle: **CLEAN** - 274 files, 6000007 bytes, 26 distinct needles, 0 hits, 0 credential-shaped strings, self-test passed (26/26).

The supplemental write, semantic-denial, handoff and multi-tenant overlay exhibits also write
canary summaries for the sensitive values they use. `terminal-survivors/` contains only
scenario and mutant names, not caller inputs.

That report covers every file that existed when it ran. This `README.md`, the report itself and
the finished `demo.log` are written afterwards, so a **second whole-bundle pass** runs once every
byte is on disk and **its** verdict is `pnpm demo`'s exit code. Its output is on the console and
in no file, because a report of a scan that included the report is a file the scan did not
include - the recursion has to stop somewhere, and it stops with the whole bundle covered.

A committed bundle is therefore one where both passes were clean. See
[`redaction-canary/`](redaction-canary/) for how the canary proves it can fail, and for the two
things it cannot check.

## Reproducing this

```
pnpm install
pnpm -F @crr/surface-browser exec playwright install chromium   # once
pnpm demo
pnpm -F @crr/runtime exec tsx demo/write-boundary.ts
pnpm -F @crr/runtime exec tsx test/evidence/semantic-denials.ts
pnpm -F @crr/runtime exec tsx demo/handoff.ts
pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts
pnpm -F @crr/conformance exec tsx test/evidence/terminal-survivors.ts
```

`pnpm demo` deletes and rewrites only the directories it owns; the supplemental evidence
commands rewrite their own directories.
