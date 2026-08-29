# `/evidence` — what was actually run, and what was not

**Every file in this directory was produced by `pnpm demo`, on a laptop, with no live service**
**of any kind.** The only two things `pnpm demo` needs are a Chromium build and a free TCP port.

**All data is synthetic.** `fixtures/corebank-web` is a purpose-built hostile back office; the
members, balances and account numbers in it exist nowhere else and are marked `(SYNTHETIC)` on
the screens themselves. No real PII and no real credential appears in this repository.

## The live discovery run

[`discovery-live/`](discovery-live/) holds a real one, produced by `pnpm discover --yes`.
It is the only thing in this bundle a model produced; read its own `README.md` and
`provenance.json` for the adapter, the model id, the measured token usage and the measured
spend. Everything else below is a **replay**, which is the half that runs in production
with no model in the decision path.

## Provenance — which adapter produced what

| Directory | Produced by | Model |
|---|---|---|
| [`artifact/`](artifact/) | hand-authored for build unit 11's acceptance test | **none** |
| `replay-0*/` | `@crr/runtime` `replay()` over `@crr/surface-browser` | **none — no model is in the decision path of a replay, by design** |
| [`cli-replay/`](cli-replay/) | the shipped `crr` binary | **none** |
| [`masked-capture/`](masked-capture/) | `@crr/surface-browser` `capture()` | **none** |
| [`redaction-canary/`](redaction-canary/) | `@crr/runtime` `runRedactionCanary()` | **none** |
| [`discovery-live/`](discovery-live/) | `pnpm discover` — the `anthropic` adapter against the Messages API | see `discovery-live/provenance.json` |

### About `artifact/`

`artifact/artifact.json` was **hand-authored**, not synthesized from a discovery run, and its
`provenance.model.adapter` says `replay` with a model id of `none:hand-authored-for-unit-11`
because that enum has no honest value for "a person wrote this". Every matcher in it was derived
from a real `perceive()` over the fixture through `@crr/surface-browser` — none of it was written
by reading the fixture's HTML — but a model did not produce it and this bundle does not pretend
one did. When the live discovery run happens, the artifact that synthesis emits replaces it and
this paragraph goes away.

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

Four of the five replays hit an exceptional state, and they are exceptional in three different
ways — an expected business outcome, a recoverable condition, and two hard failures. That split
is the product: `MEMBER_NOT_FOUND` is a typed **answer** the caller acts on, an interstitial is a
**bounded, budgeted, reported** remedy, and an application error page is a **stop** that names the
step, the expectation and the observation.

Each scenario directory holds `result.json` (what the calling agent receives), `journal.jsonl`
(the structured journal, written as the run happened), `run.log` (that scenario's console
output) and `observations/` — the run's evidence sink, holding content-addressed frozen
`Observation`s (each already through `redactObservation`) plus the journal blob the run's
`journalRef` points at. A green run freezes no observation, because these steps declare
`captureOn: ["failure"]`; the two hard failures each freeze the screen that failed, and that
file is a `classify()` unit test with no reproduction step attached to it.

## What is NOT here, and why

- **A permission denial.** The fixture serves both of SPEC §4.2's denial rows — one scoped to the
  record (a business outcome) and one to the session role (a hard failure) — but both are served
  on the **commit** route, and this capability is READ-only: it stops at the prepared sub-account
  form and never posts. Arming a fault the flow cannot reach and presenting the resulting
  checkpoint failure as a permission denial would be a fabricated exhibit. The two rows are
  exercised over frozen observations in `@crr/conformance`'s corpus instead — `a denial scoped
  to the RECORD is MEMBER_RESTRICTED` and `a denial scoped to the SESSION ROLE is
  entitlement-denied, a hard failure`, both mirroring this fixture's own fault ids.
- **A write.** Same reason. The irreversible boundary is exercised by `replay-dry` in
  `packages/runtime/test/verify.test.ts` ("does not perform the write twice"), over `MockSurface`.
- **A second tenant.** `packages/runtime/test/browser-overlay.test.ts` replays this artifact at
  the `summit` variant through an overlay; it is not in this bundle only because `pnpm demo`
  keeps to one surface.

## The redaction canary

`pnpm demo` finishes by grepping this entire directory for **every parameter value the runs
were given**, in fourteen encodings — the literal, UTF-16LE, JSON `\uXXXX`, percent-encoded,
HTML entities, hex, and base64 at all three byte alignments — plus the inflated text chunks of
any PNG, and every file NAME.

Where a needle could not be built it says so rather than omitting it: a five-digit member number
is eight base64 characters, of which only three to five are independent of the value's byte
alignment, which is too few to tell from noise. Those pairs are listed under `not searched` in
[`redaction-canary/report.txt`](redaction-canary/report.txt). An encoding that was never searched
for is not coverage, and a report that quietly dropped it would be claiming more than it checked.

Result of the run that produced this bundle: **CLEAN** — 61 files, 1155302 bytes, 26 distinct needles, 0 hits, 0 credential-shaped strings, self-test passed (26/26).

That report covers every file that existed when it ran. This `README.md`, the report itself and
the finished `demo.log` are written afterwards, so a **second whole-bundle pass** runs once every
byte is on disk and **its** verdict is `pnpm demo`'s exit code. Its output is on the console and
in no file, because a report of a scan that included the report is a file the scan did not
include — the recursion has to stop somewhere, and it stops with the whole bundle covered.

A committed bundle is therefore one where both passes were clean. See
[`redaction-canary/`](redaction-canary/) for how the canary proves it can fail, and for the two
things it cannot check.

## Reproducing this

```
pnpm install
pnpm -F @crr/surface-browser exec playwright install chromium   # once
pnpm demo
```

`pnpm demo` deletes and rewrites everything here except `discovery-live/`.
