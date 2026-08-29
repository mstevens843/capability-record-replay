# artifact — the three documents a replay links

**SPEC §0.4: three documents, three readers.** They are separate files here because they are
separate files in the design, and the separation is what lets one contract be implemented by
two programs — a browser one and a green-screen one.

| File | Reader | What it may contain |
|---|---|---|
| `contract.json` | the calling agent and the product owner | typed inputs and outputs, outcome **names**, prose. **Zero surface detail and no detector.** |
| `artifact.json` | the interpreter and the security reviewer | the program: steps, targets, detectors, budgets, effects, provenance, the lifecycle and the approval. |
| `allowlist.json` | the deployment | the origins, route patterns, action kinds and effect ceiling this installation permits. A program that authorized itself would not be authorized. |
| `approver.spki.pem` | anyone verifying | the **public** half of the ed25519 approval key. |

## Not one descriptor here is a selector, and none could be

This product has no test ids, no `data-*` attributes and no `<label for>`, and its generated
element ids differ per tenant (`ctl00_ctl32_g_9a1_txtMemberId` at one, `ctl00_ctl41_g_c7e2_txtMbrNo`
at the next). A target is a role plus an accessible name, a label anchor, a table cell relative to
a column header, or an ordinal within a landmark — resolved independently at replay time and
**compared**. Disagreement is a refusal, not a fallback chain.

## No member number appears in either document

`grep` it. The caller's argument is a typed parameter and the artifact stores its **shape**
(`digits`, `minLength: 5`, `maxLength: 5`), the goal template says `{memberId}`, and the routes
are patterns (`/member/:memberId`). One mechanism — parameterization — is simultaneously the
reusability story, the PII control and the route-canonicalization story.

## Provenance, said plainly

**Hand-authored.** `provenance.model.adapter` reads `replay` and the model id is
`none:hand-authored-for-unit-11`, because that enum has no value meaning "a person wrote this".
Every matcher in it was derived from a real `perceive()` over the fixture through
`@crr/surface-browser`, but no model produced it. For one a model DID produce, see `../discovery-live/`.

## The approval

The signature is over the **digest string**, and the digest is over the JCS canonical form of
the document with `lifecycle` excluded — so editing any other field changes the digest and the
signature stops verifying. `crr replay --trusted-key` checks it; `../cli-replay/console.txt` is
that check passing. The key pair is generated per process and the private half is never written
anywhere, so these two files differ on every demo run while the digest does not.
