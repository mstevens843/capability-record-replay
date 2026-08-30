# Approval Model

This project uses two approval statements for two different questions.

## Artifact Approval

Artifact approval means: this reviewed procedure is allowed to exist.

Today this is the existing lifecycle receipt from `packages/runtime/src/lifecycle.ts`: `approve()`
signs the artifact digest with the local `ApprovalSigner` port, and replay link check 27 verifies
that the approved artifact still hashes to that digest and that the deployment trusts the signing
key.

Limitations remain intentional and visible:

- Artifact approval is not a per-execution authorization.
- The lifecycle receipt is not the rich `capability.approval/v1` document.
- Artifact approval has no expiry, authority role, request binding or approval-id revocation list.
- Revoking an artifact approver today means removing or distrusting its key at link time.
- No external KMS or HSM integration is implemented for artifact approval.

## Invocation Approval

Invocation approval means: this specific irreversible execution is authorized now.

This is the stronger model implemented in `packages/core/src/approval.ts` and enforced in
`packages/runtime/src/interpreter.ts` before a `WRITE_IRREVERSIBLE` action can dispatch. The model
requires subject `invocation`, an irreversible effect ceiling, artifact digest, contract digest,
tenant scope, app-instance scope, policy version, signer identity, signer authority, key id,
issued-at, expiry, request args hash and request idempotency binding when the invocation presents
an idempotency key.

The runtime verifier is data-only. It receives the approval document, a trust store, the demand
assembled from the linked program and invocation, and `now`. The model does not decide approval.
Rejected approvals journal `approval.refused`, return `approval-required`, and do not call
`Surface.act` for the irreversible action. Accepted approvals journal `approval.accepted` and mint
the legacy policy token only after the rich approval has verified, so the older policy engine still
sees the same rule-8 gate without owning approval semantics.

## Custody Seam

`packages/runtime/src/approval.ts` contains the local ed25519 implementation for tests and demos:
`generateApprovalKeyPair`, `localApprovalKeySigner`, `signApprovalDocument` and
`ed25519TrustStore`. `externalApprovalSigner` is the adapter seam for a deployment that signs via a
KMS or HSM. No vendor-specific KMS/HSM client is hard-coded or exercised here.

The trust store supports key ownership, authority roles, validity windows, `supersedes` for
rotation, key status revocation and approval-id revocation. Persistence, operator identity proof
and key lifecycle administration remain deployment responsibilities.

## Evidence

Approval decisions are journal events, not UI state. Refusals carry typed reasons such as
`artifact-digest-mismatch`, `contract-digest-mismatch`, `approval-expired`,
`tenant-not-in-scope`, `app-instance-not-in-scope`, `signer-unknown`,
`signer-key-revoked`, `approval-revoked`, `effect-class-escalation`,
`args-hash-mismatch` and `idempotency-key-mismatch`.

Sensitive argument values are not written into approval journals. Request identity uses
`approvalArgsHash(approvalId, args)`, salted with the approval id. The salt protects the hash as it
passes through logs; it is not a claim that an approval document at rest is secret.

The current verification points are:

- `pnpm -F @crr/core test approval.test.ts` - 20 approval-schema and verifier tests.
- `pnpm -F @crr/runtime test write-boundary.test.ts` - 23 runtime write-boundary tests.
- `pnpm -F @crr/runtime test browser-write.test.ts` - browser fixture write path with invocation
  approval accepted at the final commit.
