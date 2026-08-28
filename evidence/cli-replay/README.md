# cli-replay

The same nine-step replay driven by the shipped `crr` binary rather than by the demo's own
call into `replay()`, so the bundle contains one transcript a reviewer can reproduce verbatim:

```
$ node packages/runtime/dist/cli.js replay evidence/artifact/contract.json evidence/artifact/artifact.json --surface packages/runtime/demo/surface-entry.mjs --args '{"memberId":"<A FIVE-DIGIT MEMBER NUMBER>"}' --allowlist evidence/artifact/allowlist.json --trusted-key ops-approval-key-1:evidence/artifact/approver.spki.pem --tenant riverbend --app riverbend-corebank-fixture --journal evidence/cli-replay/journal.jsonl --evidence evidence/cli-replay/observations
```

`--surface` is a **module path**, not a flag with a fixed set of values. `@crr/runtime` does
not import Playwright anywhere in `src/` - a contract test in `@crr/core` fails if it ever
does - so the driver is genuinely a parameter and a green-screen factory drops in unchanged.

`--trusted-key` verifies the ed25519 approval signature over the artifact's digest. The key
pair is generated per process (a private key in a repository is a private key on the
internet), so `approver.spki.pem` and the signature in `artifact.json` change on every demo
run while the digest they cover does not.

Exit code follows the arm: `0` ok, `2` a business outcome, `1` anything else. An outcome is
not an error, and a shell script has to be able to tell those apart.
