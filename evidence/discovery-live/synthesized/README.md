# synthesized/

Emitted by `@crr/discovery`'s `synthesizeCapability()` from the run recorded in
`../transcript.json` — adapter **`anthropic`**, model id
**`claude-opus-5`**.

No model was in the loop for this step. Synthesis is deterministic: the same recording
produces the same bytes, which is why the artifact can be content-addressed at all.

| file | what it is |
|---|---|
| `contract.json` | the typed capability contract — inputs, outputs, outcomes. Bare, so it parses. |
| `artifact.json` | the flow. Bare, so its digest is intact; it states its own adapter and model id in `provenance.model`. |
| `report.json` | what synthesis could not decide without a person. |

`contract.json` and `artifact.json` carry no added provenance field on purpose: an
approval signs over the artifact's digest, and a wrapper key would move the value being
signed to say what this file already says.
