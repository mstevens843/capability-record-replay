# Proposal: contract-first capability artifacts

**Design proposal. Nothing here is built, nothing here is measured.** Every claim in this document is
an argument, not a receipt. Where I say a rule is "enforced", I mean I am proposing a validator or a
contract test that enforces it, and until that test exists and is green the rule is a wish. The
sibling repos in this workspace lead with what they have not proven; this document does the same.

Assigned angle: **design the system starting from the caller.** The caller is an LLM-driven agent
that invokes a capability by name with typed arguments, exactly like a tool/function definition.

---

## 1. Thesis

**The capability is a typed function; the recorded flow is one implementation of it.** Most designs
in this space grow the other way — a step list with some metadata bolted on — and the shape of that
mistake is visible in the result contract, where "no such member" comes back as an exception because
the exception was the only channel that existed. I invert the layering: a `CapabilityArtifact` is a
`contract` plus an `impl`, the contract is separately versioned, separately hashed and separately
approvable, and it can be published to an agent catalog without shipping a single step. Three things
fall out of that inversion, and they are the whole design. First, the **closed set of named business
outcomes lives in the contract**, so `MEMBER_NOT_FOUND` is a value of a declared union with its own
typed payload and its own reviewed agent guidance — a caller cannot reach it from a `catch` block
because the engine never throws it, and a caller cannot forget it because the switch is exhaustive
over `C["outcomes"][number]["name"]`. Second, the contract is **tenant-independent and
surface-independent**: overlays and drivers may change how a step finds a control, never what the
capability promises, so an agent written once works across hundreds of institutions or fails loudly,
never differently. Third, the contract is the **only thing the model sees** — the catalog projection
is a pure function of it, and the step list, the descriptors and the diagnostics are operator-facing
and deliberately withheld from the model, because a model that can see the selector will try to fix
the selector.

---

## 2. Start at the call site

This is the code I want to be able to write. Everything below exists to make it true.

```ts
import { catalog } from "@capability-record-replay/host"
import { readSavingsBalance } from "./capabilities.generated"   // types only, from the contract

const r = await catalog.invoke(readSavingsBalance, {
  tenant:  { tenantId, appInstanceId },
  args:    { memberId: "0000123456" },          // typed from the contract's inputs
  onIntervention: "suspend",                     // this caller is a live chat turn, it can wait
  correlation: { agentSessionId, requestedBy: "agent" },
})

switch (r.status) {
  case "ok":
    // r.outputs is OutputsOf<typeof readSavingsBalance>
    return say(`Your savings balance is ${r.outputs.savingsBalance.amount}.`)

  case "outcome":
    // Exhaustive over the DECLARED outcome names. Adding one is a compile error at every call site.
    switch (r.outcome) {
      case "MEMBER_NOT_FOUND":
        // r.data is narrowed to this outcome's payload
        return say(r.guidance)                   // reviewed at approval time, not improvised now
      case "ACCOUNT_RESTRICTED":
        return handoffToBranch(r.data.restrictionCode)
    }

  case "suspended":
    // NOT a failure. A human is finishing it. Say something true and come back.
    return say("Let me check that with a specialist — I'll follow up shortly.")

  case "failed":
    // The only arm that means "the system is broken". r.expected / r.observed are for the operator.
    return escalate(r.run.runId, r.reason)
}
```

Four hard rules at this boundary, each of which is a test rather than a convention:

| rule | why |
|---|---|
| **`invoke` never rejects.** No thrown outcome, no thrown failure, no thrown validation error. A rejected promise from `invoke` is a bug in the host. | The caller is frequently an LLM harness. A thrown exception at a tool boundary is a crash the model cannot see, reason about, or report honestly to a member. |
| **`ok` is only returned when every `required` declared output validated.** Extraction that produces nulls is `failed` with `CONTRACT_VIOLATION`, never `ok` with holes. | A false success is the worst outcome this system can produce. It is the invariant the conformance suite exists to grade. |
| **Business outcomes never travel through the failure arm, and failures never travel through the outcome arm.** The two are produced by different code paths that cannot reach each other. | The glossary calls conflating them "the most common design mistake here". Making them different *arms of the same union* rather than different *codes in one error object* is what makes the compiler care. |
| **`suspended` is the only non-terminal arm.** | An escalated run is not a failed run. Collapsing them makes the agent apologise for something that is about to succeed. |

### 2.1 The invocation type

```ts
/**
 * What a caller hands in. Generic over the contract so args, approval and budgets are all
 * checked against the specific capability, not against a bag of strings.
 */
export interface Invocation<C extends CapabilityContract> {
  /** Exact pin. The catalog serves exactly one approved version per (capability, tenant). */
  readonly capability: { readonly name: C["name"]; readonly version: ContractVersion }

  /** Which institution and which of that institution's app instances. Never inferred. */
  readonly tenant: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId }

  /** Typed from the contract's declared inputs. See ArgsOf below. */
  readonly args: ArgsOf<C>

  /**
   * Caller-supplied dedupe key. The host returns the prior result for a repeat key rather than
   * re-driving the UI. Exists because retries at the agent layer are inevitable and a retried
   * WRITE against a legacy screen is how a member gets two sub-accounts.
   */
  readonly idempotencyKey?: string

  /**
   * What this caller can tolerate when the run gets stuck. A batch job says "fail" and goes home;
   * a live conversational turn says "suspend" and picks the run back up. The engine must not guess
   * this, because the right answer depends entirely on who is waiting.
   */
  readonly onIntervention: "suspend" | "fail"

  /** Wall-clock ceiling and recovery ceiling for THIS call, clamped by the artifact's own budgets. */
  readonly budget?: { readonly wallClockMs: number; readonly maxRecoveryAttempts: number }

  /** Goes into the journal. Answers "who asked for this" during an audit, which is not optional here. */
  readonly correlation: { readonly agentSessionId: string; readonly requestedBy: "agent" | "human" | "schedule" }
}

/**
 * The approval token is required by the TYPE when the capability is irreversible, and forbidden
 * when it is not. You cannot forget it, and you cannot smuggle one onto a READ to look important.
 */
export type WithApproval<C extends CapabilityContract> =
  C["effect"] extends "WRITE_IRREVERSIBLE"
    ? Invocation<C> & { readonly approval: ApprovalToken }
    : Invocation<C> & { readonly approval?: never }
```

---

## 3. The replay result contract

```ts
export type ReplayResult<C extends CapabilityContract> =
  | ReplayOk<C>
  | ReplayOutcome<C>
  | ReplaySuspended<C>
  | ReplayFailure

/** The flow ran to its final checkpoint and every required output validated. */
export interface ReplayOk<C extends CapabilityContract> {
  readonly status: "ok"
  readonly outputs: OutputsOf<C>
  readonly run: RunEnvelope
}

/**
 * A DECLARED business outcome. Distributive over the contract's outcome tuple, so `switch (r.outcome)`
 * narrows `r.data` to that outcome's own payload. This is the type-level answer to
 * "how do you stop a caller confusing MEMBER_NOT_FOUND with an error":
 *   - it is a different arm of the union than `failed`, with a different discriminant value;
 *   - it carries `status: "outcome"`, and there is no `error` field anywhere on it to read;
 *   - the engine reaches it by a *return*, never a throw, so no catch block can ever observe it;
 *   - its name is a literal type from the contract, so the switch is exhaustive and adding an
 *     outcome to a capability is a compile error at every existing call site — which is correct,
 *     because a new possible answer IS a breaking change for the caller.
 */
export type ReplayOutcome<C extends CapabilityContract> =
  C["outcomes"][number] extends infer O
    ? O extends OutcomeSpec
      ? {
          readonly status: "outcome"
          readonly outcome: O["name"]
          readonly data: FieldsOf<O["payload"]>
          /** Always true in v1: an outcome ends the run. Non-terminal outcomes are a Cut (§11). */
          readonly terminal: true
          /** Declared, not inferred. Tells the caller whether trying again could ever help. */
          readonly retryable: O["retryable"]
          /** The reviewed sentence from the contract. The agent may quote it; it did not invent it. */
          readonly guidance: string
          readonly run: RunEnvelope
        }
      : never
    : never

/** Automation stopped and a human was asked to take the live session. Not terminal. */
export interface ReplaySuspended<C extends CapabilityContract> {
  readonly status: "suspended"
  readonly intervention: {
    readonly id: InterventionId
    readonly reason: SuspensionReason
    readonly atStep: StepId
    /** One sentence an operator can triage from without opening anything. */
    readonly summary: string
    readonly consoleUrl: string
    /** After this, the lease expires and the run converts to `failed`. Sessions do not wait forever. */
    readonly expiresAt: string
  }
  readonly resume: { readonly token: LeaseToken; readonly pollAfterMs: number }
  /**
   * Everything already extracted and validated. Usually enough for the agent to say something TRUE
   * to the member instead of something vague ("I found your account, I'm checking the balance").
   */
  readonly partialOutputs: Partial<OutputsOf<C>>
  readonly run: RunEnvelope
}

export type SuspensionReason =
  /** An observation matched no declared outcome, no declared recovery, and failed the checkpoint. */
  | "UNCLASSIFIED_STATE"
  /** A declared recovery ran out of attempts or budget and its spec says escalate rather than fail. */
  | "RECOVERY_EXHAUSTED"
  /** Policy classified the next action irreversible and no approval token was presented. */
  | "APPROVAL_REQUIRED"
  /** Descriptors disagreed on a WRITE step. We refuse to guess which control to click. */
  | "TARGET_AMBIGUOUS"
  /** The session's authenticated context is gone and re-establishing it is a human act. */
  | "SESSION_LOST"

/** Hard failure. Everything the brief asks for on a failure: what step, what was expected, what was observed. */
export interface ReplayFailure {
  readonly status: "failed"
  readonly reason: FailureReason
  readonly atStep: StepId | null
  /** Rendered from the DECLARED checkpoint. Deterministic prose, generated, never hand-written twice. */
  readonly expected: string
  /** Rendered from the actual Observation at the moment of failure. */
  readonly observed: string
  /** Hash of that Observation. The full frozen tree is in evidence; this is what the log carries. */
  readonly observationDigest: Digest
  /** Reason-specific structure, so tooling does not parse prose. */
  readonly detail: FailureDetail
  readonly retryable: "never" | "after_delay" | "with_different_inputs"
  readonly run: RunEnvelope
}

/**
 * Hard failures only. Anything a capability author DECLARED is an outcome or a recovery and does
 * not appear here. This list is therefore short on purpose: it is the set of things that mean
 * "the system, not the business, has a problem".
 */
export type FailureReason =
  | "CHECKPOINT_FAILED"        // reached the step, state is not what the artifact says it should be
  | "UNCLASSIFIED_STATE"       // matched nothing; escalation declined by the caller (onIntervention: "fail")
  | "TARGET_NOT_FOUND"         // no descriptor resolved a node
  | "TARGET_AMBIGUOUS"         // descriptors resolved DIFFERENT nodes. Never a fallback. See §8.
  | "RECOVERY_BUDGET_EXHAUSTED"
  | "POLICY_DENIED"            // the single chokepoint refused the action
  | "APPROVAL_REQUIRED"        // irreversible, no token, caller cannot suspend
  | "LEASE_LOST"               // someone else holds the session; we refuse to act
  | "SESSION_LOST"
  | "SURFACE_UNAVAILABLE"      // the driver itself is down
  | "TIMEOUT"                  // wall-clock budget exceeded
  | "INVALID_ARGUMENTS"        // args failed the contract's input schema. A FAILURE, not a throw.
  | "ARTIFACT_INVALID"         // digest mismatch, unapproved artifact, or missing surface capability
  | "CONTRACT_VIOLATION"       // required outputs did not validate. We refuse to return a false success.

export type FailureDetail =
  | { readonly kind: "checkpoint"; readonly detector: string; readonly nearestNodes: readonly NodeFingerprint[] }
  | { readonly kind: "ambiguity"; readonly resolutions: readonly { readonly descriptor: DescriptorKind; readonly selected: NodeFingerprint | null }[] }
  | { readonly kind: "recovery"; readonly recovery: string; readonly attempts: number; readonly lastObservationDigest: Digest }
  | { readonly kind: "policy"; readonly rule: string; readonly action: string; readonly effect: ActionEffect }
  | { readonly kind: "arguments"; readonly violations: readonly { readonly field: string; readonly problem: string }[] }
  | { readonly kind: "outputs"; readonly missing: readonly string[]; readonly unparsable: readonly string[] }
  | { readonly kind: "plain"; readonly message: string }

/** Carried identically by all four arms. The audit surface of a run. */
export interface RunEnvelope {
  readonly runId: RunId
  readonly capability: { readonly name: CapabilityName; readonly version: ContractVersion; readonly artifactDigest: Digest }
  readonly tenant: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId }
  /** Which overlay applied and the fingerprint of the merge. Divergence tracking hangs off this (§9). */
  readonly resolution: { readonly overlayDigest: Digest | null; readonly fingerprint: Digest }
  readonly startedAt: string            // ISO. For humans. No decision in this system reads a clock.
  readonly durationMs: number
  readonly stepsExecuted: number
  readonly recoveriesApplied: readonly { readonly name: string; readonly attempts: number }[]
  /** Who held the control lease, when, and for which steps. This is how a human's edits are attributed. */
  readonly controllerHistory: readonly ControllerSpan[]
  readonly evidence: readonly EvidenceRef[]
  readonly policyDecisions: number      // count only; the details live in the journal, not the result
}

export interface ControllerSpan {
  readonly controller: "automation" | "human"
  readonly actorId: string
  readonly fromStep: StepId
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}
```

### 3.1 Two audiences, two renderings, one result

`ReplayResult` is for a **program**. A model does not receive a discriminated union; it receives
text. So the host renders a second, deliberately poorer view:

```ts
/** What the LLM actually gets back from the tool call. A pure function of ReplayResult + contract. */
export interface AgentToolResult {
  /** Four values, and "outcome" is not a synonym for "error". The model reads this first. */
  readonly status: "ok" | "outcome" | "pending" | "error"
  readonly outcome?: string                       // present iff status === "outcome"
  readonly data?: Record<string, unknown>         // declared outputs, or the outcome's payload
  /** Reviewed guidance from the contract. What to do next. Authored by a human at approval time. */
  readonly guidance: string
  readonly retryable: "never" | "after_delay" | "with_different_inputs"
  readonly runId: string
  /** For "error"/"pending": the string a member can quote to a human. */
  readonly reference?: string
}

export function renderForAgent<C extends CapabilityContract>(
  r: ReplayResult<C>, c: C,
): AgentToolResult
```

What `renderForAgent` **removes**, and why:

- **step ids, descriptors, `expected`/`observed`, observation digests.** A model handed a locator
  will try to route around it, and a model handed "expected heading 'Member Detail'" will try to
  navigate there directly. Diagnostics are for the operator console and the journal.
- **`suspended` becomes `pending`.** The model has no session; from its side the run has not
  finished. Same fact, the model's vocabulary.
- **nothing is added.** `guidance` is copied from the declared `OutcomeSpec`, or from a static
  per-`FailureReason` guidance table in the host, never
  generated at render time. The playbook for "the member does not exist" was reviewed by a person
  once; it is not re-derived on every call by the thing most likely to get it wrong.

Redaction cuts the other way here, and the distinction is worth stating because it is routinely
blurred: **taint controls persistence, not delivery.** A `sensitive` output is delivered to the
caller — reading the balance is the entire point of the call — and is excluded from artifacts,
journals, screenshots and traces.

---

## 4. How the capability advertises itself

`toToolDefinition` is a **pure function of the contract**. It never reads the flow, never reads the
overlay, never reads a step. That is the test that the contract/impl split is real: if the catalog
needed the steps, the split would be decoration.

```ts
export function toToolDefinition(entry: CatalogEntry): AnthropicToolDefinition
export function toCatalogEntry(c: CapabilityContract, stats: CapabilityStats | null, b: BindingSummary): CatalogEntry
```

```ts
export interface CatalogEntry {
  readonly name: CapabilityName
  readonly version: ContractVersion
  readonly title: string
  readonly summary: string                 // one line, for a list view
  readonly description: string             // model-facing prose, generated (see below)
  /** Routing hints. Models mis-route far more often than they mis-fill arguments. */
  readonly whenToUse: readonly string[]
  readonly whenNotToUse: readonly string[]
  readonly inputSchema: JSONSchema         // derived from ParamSpec[]
  readonly returns: {
    readonly ok: JSONSchema                // derived from OutputSpec[]
    readonly outcomes: readonly { readonly name: string; readonly summary: string; readonly payload: JSONSchema }[]
  }
  readonly effect: ActionEffect
  readonly requiresApproval: boolean
  readonly idempotent: boolean
  /**
   * Joined at read time from a SEPARATE stats record — NOT part of the hashed artifact. If replay
   * statistics lived inside the contract, the digest would change on every run and an approval
   * signature would mean nothing. Sample size is always shown so the number can be disbelieved.
   */
  readonly reliability: { readonly replays: number; readonly successRate: Decimal; readonly p50Ms: number; readonly p95Ms: number; readonly windowDays: number } | null
  readonly status: "draft" | "approved"
  readonly dataClasses: readonly DataClass[]   // for the compliance reviewer, not the model
}
```

Three opinions about the projection:

1. **The outcome set goes into the `description` prose, not only into `returns`.** Models read a
   tool description reliably and read a nested `returns` schema unreliably. The generator emits, from
   the contract and nothing else: *"May instead return one of these expected outcomes, which are
   answers and not errors: `MEMBER_NOT_FOUND` — no member matches that number; `ACCOUNT_RESTRICTED`
   — the member exists but the account is restricted."* Written once, in the contract; rendered into
   both places by code, so they cannot drift apart.
2. **The catalog is rendered per caller, never globally.** An agent session for tenant `riverbend`
   is shown the capabilities that have an approved artifact bound to `riverbend`'s app instance.
   A `draft` capability is never advertised to a production agent, and a capability whose stored
   digest does not verify is not advertised at all.
3. **`effect`, `requiresApproval` and `idempotent` are advertised.** The agent needs to know before
   calling whether this is a read, whether it needs a human's approval token, and whether a timeout
   can be safely retried. A tool catalog that hides its own side-effect class forces the model to
   guess, and it guesses optimistically.

```jsonc
// Generated tool definition. This is the whole model-facing surface of the capability.
{
  "name": "corebank_member_read_savings_balance",
  "description": "Look up a credit-union member by member number and read the current balance of their primary savings account, from the CoreBank back-office web application.\n\nUse when: you have a member number and need a current savings balance; the member has asked what their balance is.\nDo not use when: you need a transaction history (use corebank.member.list_transactions); you only have a name or SSN and not a member number.\n\nSide effect: READ (no data is changed). Safe to retry.\nTypical latency: 4.1s p50 over 214 replays in the last 30 days; 96.7% completed.\n\nMay instead return one of these expected outcomes, which are answers and not errors:\n  MEMBER_NOT_FOUND     - no member matches that number in this institution's core.\n  ACCOUNT_RESTRICTED   - the member exists, but the savings account is restricted and the balance is withheld.",
  "input_schema": {
    "type": "object",
    "properties": {
      "memberId": {
        "type": "string",
        "description": "The member number as printed on a statement. 6-12 digits, no punctuation.",
        "pattern": "^[0-9]{6,12}$",
        "maxLength": 12
      }
    },
    "required": ["memberId"],
    "additionalProperties": false
  }
}
```

Note what is absent from that JSON: no URL, no step, no descriptor, no tenant. The capability is
advertised entirely in the vocabulary of the business.

---

## 5. The artifact schema

This is the load-bearing part of the proposal. All of it is plain TypeScript with `readonly`
everywhere; the runtime validators are zod schemas generated from these types, and the types are the
source of truth because the *shape* is what a reviewer argues about.

### 5.0 Primitives, and one rule about numbers

```ts
declare const BRAND: unique symbol
type Branded<T, B extends string> = T & { readonly [BRAND]: B }

export type CapabilityId    = Branded<string, "CapabilityId">     // stable across every version, forever
export type CapabilityName  = Branded<string, "CapabilityName">   // "corebank.member.read_savings_balance"
export type ContractVersion = Branded<string, "ContractVersion">  // "1.2.0"
export type StepId          = Branded<string, "StepId">
export type LabelToken      = Branded<string, "LabelToken">       // see §5.10: the multi-tenant hinge
export type TenantId        = Branded<string, "TenantId">
export type AppInstanceId   = Branded<string, "AppInstanceId">
export type RunId           = Branded<string, "RunId">
export type NodeId          = Branded<string, "NodeId">           // per-observation ONLY. See §7.
export type Digest          = Branded<string, "Digest">           // "sha256:9f2c..."
export type LeaseToken      = Branded<string, "LeaseToken">
export type ApprovalToken   = Branded<string, "ApprovalToken">
export type InterventionId  = Branded<string, "InterventionId">
export type EvidenceRef     = Branded<string, "EvidenceRef">      // content-addressed blob key

/**
 * Decimal-as-string. There is no IEEE-754 anywhere in this schema, at any depth, ever.
 * Two reasons, and both are load-bearing:
 *   1. The artifact is content-addressed with canonical JSON. Float serialisation is not
 *      canonical across languages, so a float would make the digest — and therefore the approval
 *      signature — platform-dependent.
 *   2. This is money in a bank. 0.1 + 0.2 is a defect, not a rounding style.
 * Every other numeric field in this schema is an integer: milliseconds, counts, indices, pixels.
 */
export type Decimal = Branded<string, "Decimal">
export interface Money { readonly amount: Decimal; readonly currency: "USD" }

/**
 * The normalised role vocabulary every driver must map onto: the ARIA role set, which is also what
 * Windows UIA and macOS AX map onto cleanly. Closed, so a descriptor cannot name a role no driver
 * can produce. Legacy markup collapses toward "generic"/"text"; that is a fact about the surface,
 * not a gap in the vocabulary, and §8 is the answer to it.
 */
export type Role =
  | "button" | "link" | "textbox" | "combobox" | "checkbox" | "radio" | "tab" | "tabpanel"
  | "table" | "row" | "cell" | "columnheader" | "rowheader" | "heading" | "list" | "listitem"
  | "dialog" | "alert" | "status" | "form" | "navigation" | "main" | "region" | "text" | "generic"
```

### 5.1 The top level

```ts
export interface CapabilityArtifact {
  readonly schemaVersion: "capability.artifact/v1"

  /** Identity that survives re-recording. Re-discovering the same flow does not mint a new id. */
  readonly capabilityId: CapabilityId

  /** THE PUBLIC FACE. Everything a caller, a catalog and a compliance reviewer needs. */
  readonly contract: CapabilityContract

  /** Which product, which surface, which entry point this particular impl targets. */
  readonly binding: SurfaceBinding

  /** THE IMPLEMENTATION. A caller never sees this. Replacing it is not a contract change. */
  readonly flow: Flow

  /** How it came to exist and what was verified about it. */
  readonly provenance: Provenance

  /** proposed -> verified -> approved -> deprecated, and the signature over the digest. */
  readonly lifecycle: Lifecycle

  /**
   * sha256 over canonical JSON of this object with `digest` and `lifecycle.approval` removed.
   * Approval signs THIS value, so an approved artifact cannot be edited without invalidating the
   * signature, and the engine refuses to run an artifact whose recomputed digest disagrees.
   */
  readonly digest: Digest
}
```

**Canonical JSON rules** (so the digest is reproducible): keys sorted by UTF-8 code unit; no
insignificant whitespace; strings NFC-normalised; no floats (§5.0); `null` never used where a key
can simply be absent; arrays significant in order. A validator rejects any artifact that does not
round-trip through the canonicaliser byte-identically.

### 5.2 The contract

```ts
export interface CapabilityContract {
  /**
   * The invocation name. Namespaced `product.entity.verb`. Stable forever — this is the string an
   * agent's prompt, an eval, and a runbook all hard-code, so renaming it is a migration, not a
   * refactor. Lowercase snake within dot-separated segments; the catalog flattens dots to
   * underscores for providers whose tool names disallow them, deterministically.
   */
  readonly name: CapabilityName
  readonly version: ContractVersion

  readonly title: string        // "Read savings balance"
  readonly summary: string      // one line for a list view

  /**
   * Model-facing prose about WHAT it does, in business vocabulary. Never mentions a screen, a
   * button or a URL: if the description leaks the implementation, the model starts reasoning about
   * the implementation, and the whole point of the artifact is that it does not have to.
   */
  readonly description: string

  /** Routing hints. Cheap to write, and they move tool-selection accuracy more than anything else here. */
  readonly whenToUse: readonly string[]
  readonly whenNotToUse: readonly string[]

  readonly inputs: readonly ParamSpec[]
  readonly outputs: readonly OutputSpec[]

  /**
   * THE CLOSED SET. Every business answer that is not the happy path. Order is significant: it is
   * the evaluation order of the detectors, and a linter rejects two same-scope outcomes whose
   * detectors both fire on any snapshot in the fixture corpus, so precedence is a safety net rather
   * than a load-bearing mechanism.
   */
  readonly outcomes: readonly OutcomeSpec[]

  /** Worst-case classification of the flow. Drives policy, approval and what the catalog advertises. */
  readonly effect: ActionEffect
  readonly requiresApproval: boolean

  /** Can the caller safely retry a timed-out invocation? A property of the business flow, declared. */
  readonly idempotent: boolean

  /** For the compliance reviewer. What regulated data this capability touches at all. */
  readonly dataClasses: readonly DataClass[]
}

export type ActionEffect = "READ" | "WRITE_REVERSIBLE" | "WRITE_IRREVERSIBLE"
export type DataClass = "member_pii" | "account_balance" | "account_number" | "transaction" | "none"
export type Sensitivity = "public" | "internal" | "sensitive"
```

### 5.3 Fields: inputs, outputs, outcome payloads

One `FieldSpec` shape serves all three, so the JSON-schema generator, the validator and the type
mapper are written once.

```ts
export interface FieldSpec {
  readonly name: string
  readonly type: ScalarType
  readonly required: boolean
  /** Model-facing. For an input this is what the agent reads to decide what to put in it. */
  readonly description: string
  /**
   * Taint label. `sensitive` values are delivered to the caller and never persisted: excluded
   * from the artifact, the journal, traces, and — via `redaction.maskTargets` — from screenshots.
   */
  readonly sensitivity: Sensitivity
  /**
   * A synthetic example for the catalog. MUST be absent when sensitivity is `sensitive`; a
   * validator enforces that, because "here is an example member SSN" in a committed schema file is
   * exactly the failure mode this whole taint model exists to prevent.
   */
  readonly example?: string
}

export interface ParamSpec extends FieldSpec {
  /**
   * Where this value flows into the flow. Derived deterministically at record time by the
   * parameterizer, never hand-written. Two jobs:
   *   1. it is how replay knows which step consumes which argument;
   *   2. it is what the policy engine reads to build screenshot mask regions for sensitive params.
   * A validator asserts every binding site references a real step, and — the important one — that
   * NO string literal anywhere in the flow matches a `sensitive` param's shape. That is the
   * mechanical version of "the artifact stores shapes, never values".
   */
  readonly bindsTo: readonly BindingSite[]
}

export interface OutputSpec extends FieldSpec {
  /** Which step extracts it. Makes `partialOutputs` on a suspended run meaningful and ordered. */
  readonly producedBy: StepId
}

export type BindingSite =
  | { readonly kind: "step_input"; readonly step: StepId }
  | { readonly kind: "route_param"; readonly step: StepId; readonly param: string }
  | { readonly kind: "row_key"; readonly step: StepId }        // "the table row whose key column equals this arg"

export type ScalarType =
  | { readonly kind: "string"; readonly shape: ValueShape }
  | { readonly kind: "integer"; readonly min?: number; readonly max?: number }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "money"; readonly currency: "USD" }
  | { readonly kind: "date"; readonly format: "YYYY-MM-DD" }

/** The SHAPE of a value. This is what replaces storing the value itself. */
export type ValueShape =
  | { readonly match: "pattern"; readonly pattern: string; readonly maxLength: number }
  | { readonly match: "length"; readonly min: number; readonly max: number }
  | { readonly match: "oneOf"; readonly values: readonly string[] }
```

### 5.4 Outcomes — the crown jewel

```ts
export interface OutcomeSpec {
  /** SCREAMING_SNAKE. Part of the caller's public API: renaming one is a breaking contract change. */
  readonly name: string

  /**
   * A literal discriminant that is never the string "error", on a type that has no error field.
   * It exists so that a code reader, a JSON reader and a model reader all get the same signal
   * without having to know the taxonomy: this is an ANSWER.
   */
  readonly kind: "business_outcome"

  /** One line, model-facing, appears verbatim in the generated tool description. */
  readonly summary: string

  /** v1: always true. An outcome ends the run; there is no "outcome, then keep going". */
  readonly terminal: true

  /**
   * Whether trying again could ever help, and how. This is the field that stops an agent burning
   * ten turns re-submitting the same member number to a core that has never heard of it.
   */
  readonly retryable: "never" | "after_delay" | "with_different_inputs"

  /**
   * The reviewed playbook. Written by a human at approval time, copied verbatim into the tool
   * result, and NEVER generated at runtime. The whole argument for a closed outcome set is that
   * somebody thought about each member of it once, in advance, calmly.
   */
  readonly agentGuidance: string

  /** Typed data this outcome carries. Often empty; sometimes the most useful part of the answer. */
  readonly payload: readonly FieldSpec[]

  /** How replay RECOGNISES it. Declared data, a pure predicate over an Observation. See §5.6. */
  readonly detector: DetectorSpec

  /**
   * Which steps may produce it. Scoping is precision: "no such member" after the search step is a
   * business outcome; the same banner appearing on the confirmation screen means something has gone
   * badly wrong and should NOT be silently reported as a clean not-found. Empty array = ambient,
   * evaluated at every step — for a genuinely any-step business answer such as MAINTENANCE_WINDOW.
   * Session expiry does NOT belong here; see §6, note 5.
   */
  readonly scope: readonly StepId[]
}
```

### 5.5 Recoveries

```ts
export interface RecoverySpec {
  readonly name: string                     // "DISMISS_KEEPALIVE_DIALOG"
  readonly kind: "recoverable_condition"
  readonly summary: string
  readonly detector: DetectorSpec
  /** Bounded remedy. Each action still passes the single policy chokepoint, like any other action. */
  readonly remedy: readonly ActionSpec[]
  readonly maxAttempts: number              // per run, per recovery
  readonly budgetMs: number
  /** Where to continue. Almost always the same step, re-running its precondition first. */
  readonly thenResumeAt: { readonly kind: "same_step" } | { readonly kind: "step"; readonly id: StepId }
  /**
   * On exhaustion: raise an intervention (a human can probably clear it) or fail hard.
   * Declared per recovery because "the page is still loading after 30s" and "an unknown dialog is
   * on screen" deserve different answers, and neither should be an engine default.
   */
  readonly escalateOnExhaustion: boolean
  readonly scope: readonly StepId[]          // empty = ambient
}
```

### 5.6 Detectors — the whole error taxonomy is this one type

```ts
/**
 * A pure predicate over an Observation. No I/O, no clock, no randomness, no host calls.
 * Consequence, and it is the single biggest testability win in the design: the ENTIRE error
 * taxonomy is unit-testable from frozen Observation snapshots with no browser, no terminal and no
 * model running. The conformance suite is built out of exactly that.
 */
export type DetectorSpec =
  | { readonly kind: "node_present"; readonly match: NodeMatch }
  | { readonly kind: "node_absent"; readonly match: NodeMatch }
  | { readonly kind: "node_state"; readonly match: NodeMatch; readonly state: keyof UIState; readonly equals: boolean }
  | { readonly kind: "text"; readonly scope: ContainerPath | null; readonly mode: TextMatchMode; readonly value: string }
  | { readonly kind: "route_is"; readonly route: string }        // canonicalised: "/member/:memberId"
  | { readonly kind: "settled" }                                  // the surface reports quiescence
  | { readonly kind: "all"; readonly of: readonly DetectorSpec[] }
  | { readonly kind: "any"; readonly of: readonly DetectorSpec[] }
  | { readonly kind: "not"; readonly of: DetectorSpec }

/**
 * `regex` is deliberately last and deliberately fenced. A pattern in an artifact is attacker-
 * adjacent input the moment an artifact can be authored by a model, so: patterns are length-capped,
 * matched against length-capped text, compiled once at load, and rejected at approval time by a
 * linter that refuses nested quantifiers. Everything an author can express with `contains` or
 * `exact` must be expressed that way; the linter warns on a regex with no metacharacters.
 */
export type TextMatchMode = "exact" | "contains" | "prefix" | "suffix" | "regex"

/** How a detector names a node. The same vocabulary as a Descriptor (§8) minus the ranking. */
export interface NodeMatch {
  readonly role?: Role
  readonly name?: NameMatch
  readonly text?: { readonly mode: TextMatchMode; readonly value: string }
  readonly container?: ContainerPath
  readonly state?: Partial<UIState>
  /**
   * Row-and-column addressing for grid layouts, keyed by VALUES rather than indices — the same idea
   * as the `table_cell` descriptor (§5.8), made available to detectors and extractors so that
   * READING a cell is as precise as CLICKING one. Without this, extraction on a legacy accounts
   * grid degrades to "some cell in this table", which is how a checking balance gets reported as a
   * savings balance.
   */
  readonly table?: { readonly rowKeyColumn: NameMatch; readonly rowKeyValue: RowKey; readonly columnHeader: NameMatch }
}

/**
 * How a table row is identified. Never an index: inserting a checking account above the savings
 * account must change nothing. Either a text value (token form so a tenant can rename "Savings" to
 * "Regular Savings" in an overlay) or an invocation argument.
 */
export type RowKey = NameMatch | { readonly kind: "param"; readonly ref: ParamRef }

/**
 * A name is matched EITHER by a literal or by a LabelToken resolved through the flow's vocabulary.
 * Token form is what makes one artifact serve many tenants: "Member Number" vs "Account Number" is
 * the single most common per-tenant difference, and it is fixed once in an overlay's vocabulary
 * rather than in forty descriptors. See §5.10.
 */
export type NameMatch =
  | { readonly kind: "literal"; readonly mode: TextMatchMode; readonly value: string }
  | { readonly kind: "token"; readonly token: LabelToken }
```

### 5.7 The flow — an implementation detail of the contract

```ts
export interface Flow {
  readonly entry: StepId
  readonly steps: readonly Step[]

  /**
   * Declared once, referenced by token everywhere. The base artifact lists the accepted synonyms
   * observed on the base tenant; an overlay REPLACES a token's list. Resolution is: first synonym
   * that resolves a unique node in the current Observation, and if two synonyms both resolve
   * DIFFERENT nodes that is an ambiguity, not a preference.
   */
  readonly vocabulary: Readonly<Record<LabelToken, readonly string[]>>

  /** Canonicalised routes only: "/member/:memberId". A literal id in this map is a validator error. */
  readonly routes: Readonly<Record<string, string>>

  /** Evaluated at EVERY step. Session expiry does not respect your step boundaries. */
  readonly ambient: {
    readonly outcomes: readonly OutcomeSpec[]
    readonly recoveries: readonly RecoverySpec[]
  }

  /** Screenshot/grid regions to blank, derived from sensitive params' binding sites. */
  readonly redaction: { readonly maskTargets: readonly StepId[] }
}

export interface Step {
  readonly id: StepId

  /**
   * WHY this step exists, in the model's own words from the discovery run. A COMMENT. The engine
   * never reads it, never branches on it, never sends it anywhere. If any executable path consumed
   * this field we would have smuggled the model back into the replay loop.
   */
  readonly intent: string

  readonly action: ActionSpec

  /** null for actions that do not target a control (navigate, wait, key-to-focused). */
  readonly target: TargetSpec | null

  /**
   * Must hold BEFORE acting. Usually null on a straight-line run; always populated on the first
   * step after a human handoff, because "resume" re-verifies rather than blindly continuing.
   */
  readonly precondition: DetectorSpec | null

  /**
   * NON-OPTIONAL. A step with no postcondition cannot be recorded — the recorder refuses and the
   * schema has no way to express it. This is the strongest single anti-"blindly proceeding"
   * mechanism available, and it costs one required field.
   */
  readonly expect: DetectorSpec

  readonly extract: readonly ExtractSpec[]

  /** Step-scoped classification is derived from OutcomeSpec.scope / RecoverySpec.scope at load. */
  readonly budget: { readonly settleMs: number; readonly timeoutMs: number }

  /** Per-step effect class. The policy chokepoint reads this, not the capability-level rollup. */
  readonly effect: ActionEffect
}

export type ActionSpec =
  | { readonly kind: "navigate"; readonly route: string; readonly params: Readonly<Record<string, ParamRef>> }
  | { readonly kind: "click" }
  | { readonly kind: "type"; readonly value: ValueSource; readonly mode: "replace" | "append" }
  | { readonly kind: "select"; readonly option: ValueSource }
  | { readonly kind: "key"; readonly keys: readonly string[] }
  | { readonly kind: "focus" }
  | { readonly kind: "scroll"; readonly to: "target" | "top" | "bottom" }
  | { readonly kind: "wait"; readonly until: DetectorSpec }
  /** Deliberately absent: no `evaluate`, no `script`, no `exec`. See §11. */

/** A value is EITHER an argument or a literal. A literal that matches a sensitive shape is rejected. */
export type ValueSource =
  | { readonly kind: "param"; readonly ref: ParamRef }
  | { readonly kind: "literal"; readonly value: string }
export type ParamRef = Branded<string, "ParamRef">     // must name a declared contract input

export interface ExtractSpec {
  readonly output: string                  // must name a declared contract output
  readonly from:
    | { readonly kind: "node_text"; readonly match: NodeMatch }
    | { readonly kind: "node_value"; readonly match: NodeMatch }
    | { readonly kind: "node_name"; readonly match: NodeMatch }
  readonly parse: ParseSpec
  /**
   * If required and extraction yields nothing, the run FAILS with CONTRACT_VIOLATION. It does not
   * return `ok` with a null. Refusing to return a well-formed lie is the point.
   */
  readonly required: boolean
}

export type ParseSpec =
  | { readonly kind: "string"; readonly trim: boolean }
  | { readonly kind: "integer" }
  | { readonly kind: "money"; readonly currency: "USD"; readonly strip: readonly string[] }   // "$", ","
  | { readonly kind: "date"; readonly from: "MM/DD/YYYY" | "YYYY-MM-DD" }
  | { readonly kind: "enum"; readonly map: Readonly<Record<string, string>> }
  | { readonly kind: "regex_capture"; readonly pattern: string; readonly group: number; readonly then: ParseSpec }
```

### 5.8 Targets and descriptors

```ts
export interface TargetSpec {
  /**
   * At least two, INDEPENDENTLY computed, ranked by discriminating power at record time.
   * Never a fallback chain. See §8 for the reasoning and the independence rule.
   */
  readonly descriptors: readonly Descriptor[]

  /**
   * `unanimous` is the default and the only value permitted on a step whose effect is not READ.
   * A validator rejects `quorum` on a WRITE step. You may guess in order to read; you may never
   * guess in order to write.
   */
  readonly agreement:
    | { readonly mode: "unanimous" }
    | { readonly mode: "quorum"; readonly minAgree: number }

  /** What was matched at record time. Compared on replay to produce the drift signal (§9). */
  readonly recordedNode: NodeFingerprint
}

export type DescriptorKind =
  | "role_name" | "label_anchored" | "table_cell" | "ordinal_in_container" | "grid_region" | "geometric"

export type Descriptor =
  /** Accessible role + accessible name. First choice everywhere it exists. */
  | { readonly kind: "role_name"; readonly role: Role; readonly name: NameMatch }

  /** The control adjacent to a label. The workhorse on markup with no programmatic labelling. */
  | { readonly kind: "label_anchored"; readonly label: NameMatch; readonly relation: "labelled_by" | "right_of" | "below" | "same_cell"; readonly role: Role; readonly container: ContainerPath }

  /** Row identified by a KEY COLUMN VALUE, column by header text. The one that works on table layouts. */
  | { readonly kind: "table_cell"; readonly container: ContainerPath; readonly rowKeyColumn: NameMatch; readonly rowKeyValue: RowKey; readonly columnHeader: NameMatch; readonly role: Role }

  /** Nth control of a role within a named container. Cheap, brittle, useful only as a cross-check. */
  | { readonly kind: "ordinal_in_container"; readonly container: ContainerPath; readonly role: Role; readonly index: number }

  /** Character-grid surfaces: a fixed screen region on a fixed screen id. */
  | { readonly kind: "grid_region"; readonly screen: string; readonly row: number; readonly col: number; readonly width: number }

  /** Offset from an anchor text. Last resort, and only ever as an Nth opinion, never alone. */
  | { readonly kind: "geometric"; readonly anchor: NameMatch; readonly dx: number; readonly dy: number; readonly tolerancePx: number }

/**
 * A stable-ish identity for a node, used for COMPARISON and DIAGNOSTICS only, never for lookup.
 * Two descriptors "agree" iff they select nodes with equal fingerprints.
 */
export interface NodeFingerprint {
  readonly role: Role
  readonly name: string | null
  readonly containerPath: ContainerPath
  readonly tablePosition: { readonly rowHeader: string | null; readonly colHeader: string | null } | null
  readonly boundsHash: string          // quantised geometry; survives font rendering, not redesigns
}
```

### 5.9 Binding, provenance, lifecycle

```ts
export interface SurfaceBinding {
  readonly surface: "browser" | "terminal" | "desktop"

  /** Vendor product identity. THIS, not the tenant, is what an artifact is really written against. */
  readonly product: { readonly vendor: string; readonly productId: string; readonly versionRange: string }

  readonly entryPoint: string                  // canonicalised route or screen id

  /**
   * Surface features this flow REQUIRES. A driver that cannot report `table_position` refuses to
   * load an artifact that uses `table_cell` descriptors, at load time, with a clear message —
   * rather than mysteriously failing on step 4 in production. This is the concrete seam between
   * "how we perceive a surface" and "the recorded flow" that the brief asks about.
   */
  readonly requires: readonly SurfaceFeature[]

  /** Named credential/session profile. The artifact names the profile; it never carries material. */
  readonly sessionProfile: string
}

export type SurfaceFeature =
  | "accessibility_tree" | "table_position" | "containers" | "geometry" | "character_grid" | "route"

export interface Provenance {
  readonly discoveredAt: string

  /**
   * The natural-language goal, PARAMETERIZED. "look up member {{memberId}} and read their current
   * savings balance". The same mechanism that makes the capability reusable makes the provenance
   * record safe to commit — the goal string is one of the easiest places to accidentally persist a
   * real member number, and here it structurally cannot hold one.
   */
  readonly goalTemplate: string

  readonly model: { readonly provider: string; readonly modelId: string; readonly promptVersion: string }

  /**
   * The raw transcript is REFERENCED, never embedded. The brief requires the artifact be decoupled
   * from the transcript; a digest + blob key is decoupling that is still auditable.
   */
  readonly transcriptRef: { readonly digest: Digest; readonly uri: string } | null

  /** Record-then-immediately-replay. See §12 for where I think this rule needs qualifying. */
  readonly verification: {
    readonly mode: "fresh_state" | "post_mutation" | "not_verified"
    readonly replayRunId: RunId | null
    readonly replayedAt: string | null
    readonly digestVerified: boolean
  }
}

export interface Lifecycle {
  readonly status: "proposed" | "verified" | "approved" | "deprecated"
  /** Signs the DIGEST, not the file. An approved artifact cannot be silently edited. */
  readonly approval: {
    readonly approvedBy: string
    readonly approvedAt: string
    readonly signature: string
    readonly keyId: string
    /** The human ticked these. Kept because "who approved the irreversible one" is an audit answer. */
    readonly acknowledgedEffects: readonly ActionEffect[]
  } | null
  readonly supersededBy: { readonly name: CapabilityName; readonly version: ContractVersion } | null
}
```

### 5.10 The overlay

```ts
/**
 * A per-tenant document of OVERRIDES ONLY. The rule that makes multi-tenancy safe is one sentence:
 *
 *     AN OVERLAY MAY NOT CHANGE THE CONTRACT.
 *
 * Not the input types, not the output types, not the effect class, not the outcome NAMES. An
 * overlay may change how a control is found, how long to wait, what a label is called locally, and
 * it may ADD recoveries. It may not add an outcome, because adding an outcome widens the union
 * every caller switches on, and a caller that compiled against `MEMBER_NOT_FOUND | ACCOUNT_RESTRICTED`
 * must not silently receive a third value at Summit Credit Union and not at Riverbend. If a tenant
 * genuinely has an extra business answer, that is a contract version bump for everyone — visible,
 * reviewed, and correct. The cost is real and I accept it (§13, risk 5).
 */
export interface CapabilityOverlay {
  readonly schemaVersion: "capability.overlay/v1"
  readonly capabilityId: CapabilityId
  readonly appliesTo: { readonly name: CapabilityName; readonly version: ContractVersion }
  readonly tenantId: TenantId
  readonly appInstanceId: AppInstanceId

  readonly overrides: {
    /** The hinge. One entry usually fixes a whole tenant. */
    readonly vocabulary?: Readonly<Record<LabelToken, readonly string[]>>
    readonly routes?: Readonly<Record<string, string>>
    readonly steps?: Readonly<Record<StepId, {
      readonly target?: TargetSpec
      readonly budget?: { readonly settleMs: number; readonly timeoutMs: number }
      readonly precondition?: DetectorSpec
      readonly expect?: DetectorSpec
    }>>
    /** ADD-only, and recoveries only. The type has no slot for an outcome. */
    readonly addRecoveries?: readonly RecoverySpec[]
  }

  readonly digest: Digest
}

/** Deterministic merge. Total, pure, and its output is hashed so a resolution is reproducible. */
export function resolve(base: CapabilityArtifact, overlay: CapabilityOverlay | null): ResolvedCapability

export interface ResolvedCapability {
  readonly contract: CapabilityContract         // byte-identical to base.contract, always
  readonly flow: Flow
  readonly binding: SurfaceBinding
  /** sha256 over (base.digest, overlay?.digest, resolved vocabulary). Goes in every RunEnvelope. */
  readonly fingerprint: Digest
}
```

### 5.11 The type mappers that make the caller's switch exhaustive

```ts
export type TsTypeOf<T extends ScalarType> =
  T extends { kind: "string" }                        ? string  :
  T extends { kind: "integer" }                       ? number  :
  T extends { kind: "boolean" }                       ? boolean :
  T extends { kind: "enum"; values: readonly (infer V)[] } ? V   :
  T extends { kind: "money" }                         ? Money   :
  T extends { kind: "date" }                          ? string  :
  never

export type FieldsOf<S extends readonly FieldSpec[]> = {
  readonly [F in S[number] as F["name"]]:
    F["required"] extends true ? TsTypeOf<F["type"]> : TsTypeOf<F["type"]> | null
}

export type ArgsOf<C extends CapabilityContract>    = FieldsOf<C["inputs"]>
export type OutputsOf<C extends CapabilityContract> = FieldsOf<C["outputs"]>
```

A `pnpm codegen` step emits, from each approved contract, a `.d.ts` with the contract declared
`as const` so these mappers resolve to literal types at the call site. That is what makes
`case "MEMBER_NOT_FOUND":` an exhaustively-checked branch rather than a string comparison.

---

## 6. A filled-in artifact

Credit-union member lookup on the `corebank-web` fixture: search → member detail → accounts tab →
read the savings balance. Strict JSON (no comments — this is the canonical form the digest is taken
over). **The `sha256:` values below are placeholders and were not computed; this document contains
no measurements.**

```json
{
  "schemaVersion": "capability.artifact/v1",
  "capabilityId": "cap_corebank_member_read_savings_balance",
  "contract": {
    "name": "corebank.member.read_savings_balance",
    "version": "1.2.0",
    "title": "Read savings balance",
    "summary": "Read the current balance of a member's primary savings account.",
    "description": "Look up a credit-union member by member number and read the current balance of their primary savings account, together with the as-of date the core reports for it.",
    "whenToUse": [
      "you have a member number and need a current savings balance",
      "the member has asked what their balance is"
    ],
    "whenNotToUse": [
      "you need a transaction history (use corebank.member.list_transactions)",
      "you only have a name or an SSN and not a member number"
    ],
    "inputs": [
      {
        "name": "memberId",
        "type": { "kind": "string", "shape": { "match": "pattern", "pattern": "^[0-9]{6,12}$", "maxLength": 12 } },
        "required": true,
        "description": "The member number as printed on a statement. 6-12 digits, no punctuation.",
        "sensitivity": "internal",
        "example": "0000123456",
        "bindsTo": [{ "kind": "step_input", "step": "s2_enter_member_number" }]
      }
    ],
    "outputs": [
      {
        "name": "savingsBalance",
        "type": { "kind": "money", "currency": "USD" },
        "required": true,
        "description": "Current balance of the primary savings account.",
        "sensitivity": "sensitive",
        "producedBy": "s5_read_savings_row"
      },
      {
        "name": "asOf",
        "type": { "kind": "date", "format": "YYYY-MM-DD" },
        "required": true,
        "description": "The date the core reports this balance as current to.",
        "sensitivity": "internal",
        "producedBy": "s5_read_savings_row"
      },
      {
        "name": "accountNumberLast4",
        "type": { "kind": "string", "shape": { "match": "pattern", "pattern": "^[0-9]{4}$", "maxLength": 4 } },
        "required": false,
        "description": "Last four digits of the savings account number, for confirming with the member.",
        "sensitivity": "sensitive",
        "producedBy": "s5_read_savings_row"
      }
    ],
    "outcomes": [
      {
        "name": "MEMBER_NOT_FOUND",
        "kind": "business_outcome",
        "summary": "No member matches that number in this institution's core.",
        "terminal": true,
        "retryable": "with_different_inputs",
        "agentGuidance": "Tell the member that no account matches that number and offer to re-check the digits with them. Do not call this capability again with the same memberId.",
        "payload": [
          {
            "name": "searchedShape",
            "type": { "kind": "string", "shape": { "match": "length", "min": 1, "max": 24 } },
            "required": true,
            "description": "The shape of what was searched for, e.g. '10 digits'. Never the value itself.",
            "sensitivity": "public"
          }
        ],
        "detector": {
          "kind": "all",
          "of": [
            { "kind": "text", "scope": "frame:main", "mode": "contains", "value": "No member found matching" },
            { "kind": "node_absent", "match": { "role": "heading", "name": { "kind": "token", "token": "memberDetailHeading" } } }
          ]
        },
        "scope": ["s3_submit_search"]
      },
      {
        "name": "ACCOUNT_RESTRICTED",
        "kind": "business_outcome",
        "summary": "The member exists, but the savings account is restricted and the balance is withheld.",
        "terminal": true,
        "retryable": "never",
        "agentGuidance": "Tell the member their account has a restriction that prevents you from reading the balance, and offer to connect them with a branch representative. Give them the run reference if they ask.",
        "payload": [
          {
            "name": "restrictionCode",
            "type": { "kind": "enum", "values": ["HOLD", "LEGAL", "DECEASED", "FRAUD_REVIEW", "UNKNOWN"] },
            "required": true,
            "description": "The restriction class shown on the account row.",
            "sensitivity": "internal"
          }
        ],
        "detector": {
          "kind": "node_present",
          "match": { "role": "status", "text": { "mode": "contains", "value": "Account restricted" }, "container": "frame:main" }
        },
        "scope": ["s4_open_accounts_tab", "s5_read_savings_row"]
      }
    ],
    "effect": "READ",
    "requiresApproval": false,
    "idempotent": true,
    "dataClasses": ["member_pii", "account_balance", "account_number"]
  },

  "binding": {
    "surface": "browser",
    "product": { "vendor": "corebank", "productId": "corebank-backoffice", "versionRange": ">=7.2 <8" },
    "entryPoint": "/backoffice/members/search",
    "requires": ["accessibility_tree", "containers", "table_position", "route"],
    "sessionProfile": "corebank-teller"
  },

  "flow": {
    "entry": "s1_open_member_search",
    "vocabulary": {
      "memberNumberField": ["Member Number", "Member #"],
      "searchButton": ["Search", "Find"],
      "memberDetailHeading": ["Member Detail"],
      "accountsTab": ["Accounts"],
      "accountTypeColumn": ["Account Type"],
      "currentBalanceColumn": ["Current Balance"],
      "accountNumberColumn": ["Account Number"],
      "savingsRowKey": ["Savings"],
      "keepAliveContinue": ["Continue Working"]
    },
    "routes": {
      "memberSearch": "/backoffice/members/search",
      "memberDetail": "/backoffice/members/:memberId"
    },
    "ambient": {
      "outcomes": [],
      "recoveries": [
        {
          "name": "DISMISS_KEEPALIVE_DIALOG",
          "kind": "recoverable_condition",
          "summary": "The session keep-alive dialog appeared over the page.",
          "detector": { "kind": "node_present", "match": { "role": "button", "name": { "kind": "token", "token": "keepAliveContinue" } } },
          "remedy": [{ "kind": "click" }],
          "maxAttempts": 3,
          "budgetMs": 5000,
          "thenResumeAt": { "kind": "same_step" },
          "escalateOnExhaustion": false,
          "scope": []
        },
        {
          "name": "WAIT_OUT_TRANSIENT_LOAD",
          "kind": "recoverable_condition",
          "summary": "The surface has not settled yet.",
          "detector": { "kind": "not", "of": { "kind": "settled" } },
          "remedy": [{ "kind": "wait", "until": { "kind": "settled" } }],
          "maxAttempts": 3,
          "budgetMs": 15000,
          "thenResumeAt": { "kind": "same_step" },
          "escalateOnExhaustion": true,
          "scope": []
        }
      ]
    },
    "redaction": { "maskTargets": ["s5_read_savings_row"] },

    "steps": [
      {
        "id": "s1_open_member_search",
        "intent": "Start from the member search screen rather than assuming where the session left off.",
        "action": { "kind": "navigate", "route": "memberSearch", "params": {} },
        "target": null,
        "precondition": null,
        "expect": { "kind": "node_present", "match": { "role": "textbox", "name": { "kind": "token", "token": "memberNumberField" } } },
        "extract": [],
        "budget": { "settleMs": 800, "timeoutMs": 15000 },
        "effect": "READ"
      },
      {
        "id": "s2_enter_member_number",
        "intent": "Put the member number in the field labelled Member Number.",
        "action": { "kind": "type", "value": { "kind": "param", "ref": "memberId" }, "mode": "replace" },
        "target": {
          "descriptors": [
            { "kind": "role_name", "role": "textbox", "name": { "kind": "token", "token": "memberNumberField" } },
            { "kind": "label_anchored", "label": { "kind": "token", "token": "memberNumberField" }, "relation": "same_cell", "role": "textbox", "container": "frame:main" },
            { "kind": "ordinal_in_container", "container": "frame:main>form:search", "role": "textbox", "index": 0 }
          ],
          "agreement": { "mode": "unanimous" },
          "recordedNode": {
            "role": "textbox",
            "name": "Member Number",
            "containerPath": "frame:main>form:search",
            "tablePosition": null,
            "boundsHash": "q:184,212,160,22"
          }
        },
        "precondition": null,
        "expect": { "kind": "node_state", "match": { "role": "textbox", "name": { "kind": "token", "token": "memberNumberField" } }, "state": "focused", "equals": true },
        "extract": [],
        "budget": { "settleMs": 200, "timeoutMs": 5000 },
        "effect": "READ"
      },
      {
        "id": "s3_submit_search",
        "intent": "Submit the search and land on the member detail screen.",
        "action": { "kind": "click" },
        "target": {
          "descriptors": [
            { "kind": "role_name", "role": "button", "name": { "kind": "token", "token": "searchButton" } },
            { "kind": "label_anchored", "label": { "kind": "token", "token": "searchButton" }, "relation": "labelled_by", "role": "button", "container": "frame:main" }
          ],
          "agreement": { "mode": "unanimous" },
          "recordedNode": {
            "role": "button",
            "name": "Search",
            "containerPath": "frame:main>form:search",
            "tablePosition": null,
            "boundsHash": "q:352,212,72,24"
          }
        },
        "precondition": null,
        "expect": {
          "kind": "all",
          "of": [
            { "kind": "route_is", "route": "/backoffice/members/:memberId" },
            { "kind": "node_present", "match": { "role": "heading", "name": { "kind": "token", "token": "memberDetailHeading" } } }
          ]
        },
        "extract": [],
        "budget": { "settleMs": 1200, "timeoutMs": 20000 },
        "effect": "READ"
      },
      {
        "id": "s4_open_accounts_tab",
        "intent": "The balance lives on the Accounts tab, not the summary tab.",
        "action": { "kind": "click" },
        "target": {
          "descriptors": [
            { "kind": "role_name", "role": "tab", "name": { "kind": "token", "token": "accountsTab" } },
            { "kind": "label_anchored", "label": { "kind": "token", "token": "accountsTab" }, "relation": "labelled_by", "role": "tab", "container": "frame:main>nav:member" }
          ],
          "agreement": { "mode": "unanimous" },
          "recordedNode": {
            "role": "tab",
            "name": "Accounts",
            "containerPath": "frame:main>nav:member",
            "tablePosition": null,
            "boundsHash": "q:96,268,88,26"
          }
        },
        "precondition": null,
        "expect": { "kind": "node_present", "match": { "role": "table", "name": { "kind": "literal", "mode": "contains", "value": "Accounts" }, "container": "frame:main" } },
        "extract": [],
        "budget": { "settleMs": 1000, "timeoutMs": 15000 },
        "effect": "READ"
      },
      {
        "id": "s5_read_savings_row",
        "intent": "Read the Current Balance cell of the row whose Account Type is Savings.",
        "action": { "kind": "wait", "until": { "kind": "settled" } },
        "target": null,
        "precondition": { "kind": "node_present", "match": { "role": "table", "container": "frame:main>table:accounts" } },
        "expect": {
          "kind": "node_present",
          "match": {
            "role": "cell",
            "container": "frame:main>table:accounts",
            "table": {
              "rowKeyColumn": { "kind": "token", "token": "accountTypeColumn" },
              "rowKeyValue": { "kind": "token", "token": "savingsRowKey" },
              "columnHeader": { "kind": "token", "token": "currentBalanceColumn" }
            }
          }
        },
        "extract": [
          {
            "output": "savingsBalance",
            "from": {
              "kind": "node_text",
              "match": {
                "role": "cell",
                "container": "frame:main>table:accounts",
                "table": {
                  "rowKeyColumn": { "kind": "token", "token": "accountTypeColumn" },
                  "rowKeyValue": { "kind": "token", "token": "savingsRowKey" },
                  "columnHeader": { "kind": "token", "token": "currentBalanceColumn" }
                }
              }
            },
            "parse": { "kind": "money", "currency": "USD", "strip": ["$", ","] },
            "required": true
          },
          {
            "output": "asOf",
            "from": { "kind": "node_text", "match": { "role": "status", "container": "frame:main", "text": { "mode": "prefix", "value": "Balances as of" } } },
            "parse": { "kind": "regex_capture", "pattern": "([0-9]{2}/[0-9]{2}/[0-9]{4})", "group": 1, "then": { "kind": "date", "from": "MM/DD/YYYY" } },
            "required": true
          },
          {
            "output": "accountNumberLast4",
            "from": {
              "kind": "node_text",
              "match": {
                "role": "cell",
                "container": "frame:main>table:accounts",
                "table": {
                  "rowKeyColumn": { "kind": "token", "token": "accountTypeColumn" },
                  "rowKeyValue": { "kind": "token", "token": "savingsRowKey" },
                  "columnHeader": { "kind": "token", "token": "accountNumberColumn" }
                }
              }
            },
            "parse": { "kind": "regex_capture", "pattern": "([0-9]{4})$", "group": 1, "then": { "kind": "string", "trim": true } },
            "required": false
          }
        ],
        "budget": { "settleMs": 500, "timeoutMs": 10000 },
        "effect": "READ"
      }
    ]
  },

  "provenance": {
    "discoveredAt": "2026-08-26T18:41:07Z",
    "goalTemplate": "look up member {{memberId}} and read their current savings balance",
    "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5", "promptVersion": "discovery/2026-08-01" },
    "transcriptRef": { "digest": "sha256:PLACEHOLDER_TRANSCRIPT", "uri": "evidence/discovery/run_01K3.jsonl" },
    "verification": {
      "mode": "fresh_state",
      "replayRunId": "run_01K4",
      "replayedAt": "2026-08-26T18:43:55Z",
      "digestVerified": true
    }
  },

  "lifecycle": {
    "status": "approved",
    "approval": {
      "approvedBy": "operator:jsmith",
      "approvedAt": "2026-08-26T19:02:11Z",
      "signature": "PLACEHOLDER_SIGNATURE",
      "keyId": "approval-key-1",
      "acknowledgedEffects": ["READ"]
    },
    "supersededBy": null
  },

  "digest": "sha256:PLACEHOLDER_ARTIFACT_DIGEST"
}
```

Five things to notice, because they are the design arguing for itself:

1. **There is not a single CSS selector, XPath, `id` attribute or generated control name anywhere.**
   The fixture's real ids look like `ctl00_ctl32_g_9a1`; none of them survive into the artifact.
2. **The only value in the file that came from a member is not in the file.** `memberId` appears as
   a shape (`^[0-9]{6,12}$`), a binding site, and a `{{memberId}}` in the goal template.
   `example: "0000123456"` is synthetic and permitted only because `memberId` is `internal`; the
   `sensitive` fields carry no example at all.
3. **`descriptors` never appear in the contract, and `outcomes` never appear in the flow.** The
   split is real: you can regenerate the whole `flow` block from a fresh discovery run and every
   caller keeps compiling.
4. **The vocabulary block is the entire multi-tenant story for this capability.** A tenant that
   says "Member #" and "Find" instead of "Member Number" and "Search" needs a nine-line overlay,
   not a re-recording.
5. **`ambient.outcomes` is empty, deliberately.** Session expiry is not a business outcome — the
   caller cannot do anything about it and the member should not hear about it — so it fails to
   `SESSION_LOST` and raises an intervention. The keep-alive *dialog*, which is recoverable, is an
   ambient recovery. That distinction is the taxonomy doing its job.

---

## 7. The Observation / Action ports

Everything above this line is written in a vocabulary that has never heard of a browser. These two
types are the only place surfaces and flows meet.

```ts
export interface Surface {
  /** Normalised snapshot. No arguments: perception is not parameterised by what you hope to find. */
  perceive(): Promise<Observation>

  /**
   * Perform one action. Takes the lease token, so the DRIVER enforces the control model too —
   * a stale automation lease cannot act on a session a human has taken, and that is a rejection
   * at the port rather than a convention upstairs.
   */
  act(action: Action, lease: LeaseToken): Promise<ActResult>

  /**
   * Evidence only. A capture is NEVER read by the decision path — no detector, no descriptor and
   * no checkpoint may consume pixels. Separating it from `perceive` is what keeps that honest, and
   * it is what lets the terminal surface be a real driver rather than a demo: its "screenshot" is
   * a text dump of the character grid and nothing upstream notices.
   */
  capture(req: CaptureRequest): Promise<Capture>

  /** Advertised at load time so an artifact requiring `table_position` never loads on a driver without it. */
  readonly features: readonly SurfaceFeature[]
}

export interface Observation {
  readonly observationId: string
  /** Monotonic counter, NOT a wall clock. Replay logs must be diffable across runs. */
  readonly seq: number
  readonly surface: "browser" | "terminal" | "desktop"
  /** Active frame / window / screen. Frameset survival lives here, not in a selector. */
  readonly container: ContainerPath
  /** CANONICALISED. "/backoffice/members/:memberId" — an Observation never carries a member number. */
  readonly route: string | null
  readonly nodes: readonly UINode[]
  /** Whether the surface believes it is quiescent. The driver owns this; see the note below. */
  readonly stability: { readonly settled: boolean; readonly pendingWork: number }
  /** Hash of the normalised tree. Cheap "did anything change", and the id a failure result quotes. */
  readonly digest: Digest
}

export interface UINode {
  /**
   * A HANDLE INTO THIS OBSERVATION ONLY. It is not stable across observations and must never be
   * written into an artifact. This comment is load-bearing: storing a node id in a recording is the
   * single most tempting mistake in this design, and it produces a flow that replays perfectly
   * once. The recorder rejects any artifact containing a NodeId-shaped value.
   */
  readonly id: NodeId
  /** Normalised role vocabulary shared by every driver — the browser's AX roles are the base set. */
  readonly role: Role
  /** Accessible name. Often null on legacy markup; that is why §8 has five other descriptor kinds. */
  readonly name: string | null
  /** Redacted at the port when taint says so. `masked` tells you it happened. */
  readonly value: string | null
  readonly masked: boolean
  readonly state: UIState
  /** Pixels on a browser, cells on a grid. Same field, different unit, declared by `surface`. */
  readonly bounds: Rect | null
  readonly containerPath: ContainerPath
  readonly parent: NodeId | null
  readonly labelledBy: readonly NodeId[]
  /** Present iff the driver advertises `table_position`. The whole reason `table_cell` works. */
  readonly tablePosition: { readonly rowIndex: number; readonly colIndex: number; readonly rowHeader: string | null; readonly colHeader: string | null } | null
  readonly text: string | null
}

export interface UIState {
  readonly disabled: boolean
  readonly focused: boolean
  readonly checked: boolean | null
  readonly expanded: boolean | null
  readonly readonly: boolean
  readonly visible: boolean
}

export type ContainerPath = string   // "frame:main>table:accounts" — a driver-normalised path, not a selector
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type Action =
  | { readonly kind: "click";    readonly node: NodeId }
  | { readonly kind: "type";     readonly node: NodeId; readonly text: string; readonly mode: "replace" | "append"; readonly sensitive: boolean }
  | { readonly kind: "select";   readonly node: NodeId; readonly option: string }
  | { readonly kind: "key";      readonly keys: readonly string[]; readonly node?: NodeId }
  | { readonly kind: "focus";    readonly node: NodeId }
  | { readonly kind: "scroll";   readonly node?: NodeId; readonly to: "target" | "top" | "bottom" }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "wait";     readonly budgetMs: number }

export type ActResult =
  /** Returns the POST-ACTION observation. See the trade-off note. */
  | { readonly ok: true;  readonly observation: Observation }
  | { readonly ok: false; readonly reason: "NOT_PERMITTED" | "LEASE_NOT_HELD" | "NODE_GONE" | "SURFACE_ERROR" | "TIMEOUT"; readonly message: string }

export interface CaptureRequest {
  /** Regions to blank before the bytes exist. Derived from resolved sensitive targets, not applied after. */
  readonly maskRegions: readonly Rect[]
  readonly format: "png" | "text_grid"
}
export interface Capture { readonly ref: EvidenceRef; readonly digest: Digest; readonly maskedRegions: number }
```

**Trade-off, stated because it is arguable.** `act` returns the post-action Observation rather than
requiring a separate `perceive()`. That couples the two operations, and a purist would separate
them. I take the coupling because "settled" is surface-specific knowledge — network-idle plus
animation-frame quiet on a browser, cursor-stable plus no pending escape sequence on a pty — and
only the driver can know it. Making the engine call `perceive()` in a loop would either push that
knowledge upward (breaking the abstraction) or race (breaking determinism).

**Two deliberate absences.** There is no `evaluate`/`script`/`exec` action, so there is no way to
reach around the surface abstraction into a browser-only escape hatch — which would also be a hole
straight through the single policy chokepoint. And there is no `Surface.findByText`-style query: all
node selection happens above the port, in the engine, from a full Observation, which is what makes
the entire target-resolution and classification path unit-testable from frozen snapshots.

---

## 8. How a step names the control it acts on

The starting constraint is not "selectors drift" — the brief has removed that problem. It is
**"assume no clean DOM, no test IDs, and possibly no DOM at all"**, and separately that the model
must never author a locator. So:

**At record time.** The model is shown an Observation and picks a `NodeId` from it. It emits an
index, not a string. Deterministic code then derives descriptors from that node, and the derivation
rule is the important part:

> **A descriptor is emitted only if it resolves to exactly one node in the recorded Observation.**
> Uniqueness is a verified property at record time, not a hope at replay time.

Descriptors are then scored for **independence** — the evidence they consume must be disjoint.
`role_name` on a `<button>Search</button>` and `label_anchored` on the same accessible name are the
same opinion wearing two hats; two such descriptors agreeing proves nothing. The recorder computes
an independence score from which node attributes each descriptor reads, and a target with fewer than
**two independent** descriptors is flagged on the artifact and blocks approval.

**At replay time.** Every descriptor resolves independently against the current Observation, and the
resulting `NodeFingerprint`s are compared.

| result | response |
|---|---|
| all agree | act |
| all resolve nothing | `TARGET_NOT_FOUND` |
| they resolve **different** nodes | `TARGET_AMBIGUOUS` — refuse to act |
| a subset resolves, `agreement: quorum`, step is `READ` | act on the majority, record the dissent as drift |
| a subset resolves, step is a WRITE | `TARGET_AMBIGUOUS` — the validator forbids `quorum` here |

**Disagreement is a detected condition, not a fallback chain.** A fallback chain is a machine for
converting an ambiguity into a confident wrong click, and on a back-office banking screen the wrong
click is a button next to the right one. Refusing costs a run; guessing costs a transaction.

**The six descriptor kinds, and why that particular six.**

| kind | reads | earns its place because |
|---|---|---|
| `role_name` | role, accessible name | Best available signal. Exists on modern web, on desktop AX/UIA, and on well-marked legacy pages. First choice everywhere. |
| `label_anchored` | nearby text + geometry + role | The workhorse on `<table>`-layout pages with no `for`/`aria-labelledby`. Humans locate the field the same way: it is the box next to the words "Member Number". |
| `table_cell` | table position + header text + a **row key value** | The one that actually works on legacy back-office screens, which are grids. Crucially it keys the row by a *value* ("the row whose Account Type is Savings"), not by index, so inserting a checking account above it changes nothing. The same addressing is available to detectors and extractors via `NodeMatch.table`. |
| `ordinal_in_container` | container path + role + index | Weak alone. Valuable as a cheap independent second opinion that disagrees loudly when a screen gains a field. |
| `grid_region` | screen id + row/col/width | The terminal surface's native form. Its existence in the schema is the proof that the port is not browser-shaped. |
| `geometric` | anchor text + offset | Last resort, permitted only as an Nth opinion. It is the only kind that would survive a surface with no tree at all, which is why it is in the vocabulary and not in the defaults. |

**Why no CSS, no XPath, no attribute matching, ever.** An artifact holding `#ctl00_ctl32_g_9a1` has
already failed the "no clean DOM" requirement, and it is unportable to the desktop and terminal
surfaces by construction. This is enforced, not encouraged: a contract test reads the engine and
contract packages off disk and fails if `querySelector`, `css`, `xpath`, `getElementById`,
`innerHTML` or a driver import appears in them, and the artifact validator rejects any string in a
descriptor position that looks like a selector.

**On the accessibility tree being thin.** On a `<font>`-tag frameset the AX tree does not lie, it
just says very little: roles collapse toward `generic`/`text` and names go null. That is precisely
why the six kinds exist and why the recorder's job is to find *two independent* ones rather than the
best one. When it cannot, the honest answer is to say so on the artifact and make a human look —
not to invent a seventh strategy.

---

## 9. Precedence, the classifier, and drift

At every observation point, in this order, with the first match winning:

```
1. lease check          — do I still hold the control lease?              -> LEASE_LOST
2. policy pre-gate      — is this action permitted at all?                -> POLICY_DENIED / APPROVAL_REQUIRED
3. step-scoped outcomes — declared order                                  -> return ReplayOutcome
4. ambient outcomes     — declared order                                  -> return ReplayOutcome
5. step-scoped recoveries                                                 -> remedy, resume, count against budget
6. ambient recoveries                                                     -> remedy, resume, count against budget
7. checkpoint (step.expect)                                               -> proceed
8. nothing matched                                                        -> UNCLASSIFIED_STATE
```

**Outcomes beat recoveries** because a recovery would spend its budget dismissing a dialog that is
in fact the answer. **Step-scoped beats ambient** because precision beats generality: "no member
found" on the search screen is a business outcome, and the same banner on a confirmation screen is
something nobody has understood yet.

```ts
/** Pure. No I/O, no clock, no model. The entire taxonomy is testable from frozen snapshots. */
export function classify(obs: Observation, step: ResolvedStep, budgets: BudgetState): Classification

export type Classification =
  | { readonly kind: "outcome";     readonly name: string; readonly payload: Record<string, unknown> }
  | { readonly kind: "recover";     readonly name: string; readonly remedy: readonly ActionSpec[] }
  | { readonly kind: "checkpoint_met" }
  | { readonly kind: "unclassified"; readonly observationDigest: Digest }
```

**`UNCLASSIFIED_STATE` is the growth mechanism, not an embarrassment.** Every occurrence freezes the
Observation into evidence and raises an intervention. A human either recognises it as a business
answer (→ a new `OutcomeSpec`, a contract version bump, a new fixture) or as a nuisance (→ a new
`RecoverySpec`, which an *overlay* can add without touching the contract). Either way the frozen
snapshot becomes a conformance-suite case, so the taxonomy grows by regression test rather than by
patch. This is the loop that makes a closed outcome set survivable.

**Drift, secondarily.** Each resolution records how many descriptors agreed and whether the selected
node's fingerprint matched `recordedNode`. Per (capability, tenant, app instance) the host keeps a
rolling divergence rate; above a threshold the resolution is flagged **`needs_specialization`** —
which is a ticket, not an outage, and the affected tenant keeps running on quorum-with-dissent for
`READ` steps and stops for writes.

---

## 10. Workspace packages

Seven, and I have argued each one down rather than up. Scope `@capability-record-replay/*`.

| package | one-line justification |
|---|---|
| **`contract`** | Every type in §3, §5 and §7, the zod validators, canonical JSON + digest, the catalog projection. Zero dependencies, zero I/O, no driver, no model. It is what a caller imports to get types without importing a browser, and it is the file a reviewer should read first. |
| **`engine`** | Replay executor, `classify`, target resolver, policy chokepoint, control lease. Pure over the `Surface` port. The contract test that it contains no CSS vocabulary and imports no driver is the reason this is not merged into `contract`. |
| **`discovery`** | The LLM loop, descriptor derivation, parameterization, and the record-then-replay verifier. **The only package that knows a model exists** — which is exactly what lets `pnpm demo` replay with no API key and no network. |
| **`surface-browser`** | Playwright + CDP `Accessibility.getFullAXTree` merged with geometry. Separate because it pulls Playwright and nobody replaying a terminal flow should. |
| **`surface-terminal`** | pty character-grid driver, Observation built from the VT screen buffer. It exists to prove the port is real rather than aspirational; if it were deleted the abstraction would become a claim. |
| **`host`** | The running program: CLI, file-backed artifact store, the agent-facing catalog endpoint, and the operator console. One package, because splitting a CLI from a 200-line HTTP server would be exactly the architecture theatre the brief says it does not reward. |
| **`conformance`** | Fault scenarios × the replay engine asserting three-way classification and zero false successes, plus deliberately weakened engines and a meta-test that fails if the suite stops discriminating between them. Separate because the mutants must be importable and the meta-test must be able to grade the suite against its own author. |

Plus two workspace members that are applications rather than libraries: `fixtures/corebank-web` and
`fixtures/corebank-tui`.

**Merges I considered and rejected:** `engine` into `contract` (kills the purity contract test, and
forces a type-only consumer to pull the executor); `discovery` into `host` (drags the model SDK into
the no-network demo path); the two surfaces into one `surfaces` package (one needs Playwright, one
needs node-pty; a consumer should install only what it runs). **Merges I would accept under
pressure:** `conformance` into `engine`'s test directory, at the cost of not being able to publish
the suite as a way to grade someone else's replay engine.

---

## 11. What I deliberately left out of the schema

| left out | why |
|---|---|
| **CSS selectors, XPath, attribute matchers, element ids** | An artifact holding one has already failed "would still work with no clean DOM", and is unportable to desktop and terminal by construction. §8. |
| **Node ids from any Observation** | They are per-observation handles. Storing one produces a flow that replays perfectly exactly once. The validator rejects them. |
| **The model transcript** | Referenced by digest + URI, never embedded. The brief requires the artifact be decoupled from the transcript; a reference is decoupling that is still auditable. |
| **Screenshots and pixel data** | Evidence is content-addressed and out of band. Nothing in the decision path may read pixels, so nothing in the artifact needs them. |
| **Conditionals, loops, expressions, arithmetic** | No `if`, no `for`, no `${}`. Branching exists only as a *terminal declared outcome*. A branch is a decision, and a decision the model did not make at record time is a decision nobody reviewed. If a flow genuinely needs to choose, that is two capabilities and the calling agent — already a general-purpose branching machine — chooses between them. |
| **Iteration over rows** | The first thing I would add: a `forEachRow` step with a declared max iteration count and a per-iteration checkpoint. Left out of v1 because a bounded loop needs its own outcome scoping story and I would rather ship none than a half-specified one. Named here as a seam, not forgotten. |
| **Retry policy at the capability level** | The contract declares `idempotent`; retrying is the caller's decision. An artifact that silently retries a WRITE is how a member gets two sub-accounts. Inside the artifact only *declared recoveries with budgets* exist. |
| **Absolute times and wall-clock deadlines** | Every budget is relative and per-step. The only dates in the schema are in `provenance` and `lifecycle`, and no decision reads a clock. |
| **Floating-point numbers, anywhere** | Canonical JSON must be byte-reproducible for the digest to mean anything, and float serialisation is not portable. Money is `Decimal`; everything else is an integer. §5.0. |
| **Credentials, cookies, session state** | The artifact names a `sessionProfile`; the host holds the material. There is no field a credential could be written into even by accident. |
| **Confidence scores and reliability stats** | They change every run. Putting them in a hashed, signed document would make the signature meaningless. They live in a separate `CapabilityStats` record joined at catalog-render time, always with the sample size attached. |
| **Tenant-specific anything in the base artifact** | Overlays. And overlays cannot touch the contract. §5.10. |
| **Natural-language instructions the engine reads** | `Step.intent` is a comment. If any executable path consumed it we would have smuggled the model back into the replay loop through the documentation. |
| **A `script`/`evaluate` action** | It would be a hole through both the surface abstraction and the single policy chokepoint. §7. |
| **Semver ranges on the caller side** | The catalog serves exactly one approved version per (capability, tenant). Pinning is a deployment decision, not a runtime negotiation. |

---

## 12. Where I think a decided constraint needs qualifying

I agree with §3.1, §3.2, §3.3, §3.5, §3.6, §3.7, §3.8 and §3.9 of the brief and this proposal is a
concrete realisation of them. One of them is under-specified in a way that will quietly produce a
false claim, and I would rather say so now than defend it later.

**§3.4, record-then-immediately-replay verification, is sound for reads and unsound for writes.**
The verification replay runs against a surface whose state the discovery run just mutated. For
`corebank.member.read_savings_balance` that is fine. For `corebank.member.open_sub_account` it is
not: the immediate replay either opens a *second* sub-account — which is a real side effect nobody
approved, on a flow specifically classified irreversible — or it hits a duplicate-detection screen
the base flow does not declare and fails, or worse, matches some over-broad detector and "verifies"
against a state that will never occur again on a fresh member.

So I keep the rule and qualify it, which is why `Provenance.verification.mode` exists:

| mode | meaning | may reach `verified(draft)`? |
|---|---|---|
| `fresh_state` | replayed against a reset fixture or a sandbox tenant seeded to the pre-discovery state | yes |
| `post_mutation` | replayed against the state discovery left behind | only if `contract.idempotent === true` |
| `not_verified` | no replay was run | never — stays `proposed` |

A non-idempotent capability whose only verification is `post_mutation` **stays `proposed`** and is
never advertised to a production agent. The cost is that write capabilities need a resettable
environment to reach `verified`, which is a real operational requirement I am choosing to name
rather than to paper over. The alternative — letting an irreversible flow be marked verified on the
strength of a replay that tested a different world — is the kind of quiet lie this whole design is
built to prevent.

---

## 13. Risks, and what this document does not establish

1. **Nothing here is measured.** No benchmark, no latency, no success rate, no replay. It is a
   design proposal and every number in the example artifact is a placeholder.
2. **Contract-first only pays off if discovery can produce a good contract.** The model proposes
   outcome names; a bad or over-broad outcome set is baked into a caller-visible closed union, and
   widening it later is a breaking change for every agent. The mitigation — human review at
   approval, and `UNCLASSIFIED_STATE` rather than silent new outcomes — is a process control, not a
   technical one, and process controls decay.
3. **A closed outcome set means low initial autonomy.** Real back-office apps have a long tail of
   states, and the first N replays of a new capability will produce a lot of `UNCLASSIFIED_STATE`
   and a lot of interventions. The system is designed to make that *visible* rather than to avoid
   it. That is the right trade and it is still a cost, and anyone reading a demo should not expect
   the tail to be short.
4. **Descriptor independence is a heuristic.** On a thin accessibility tree, two descriptors can
   look independent by attribute and be the same opinion in practice. Unanimity between two weak,
   secretly-correlated descriptors is weaker evidence than the mechanism implies.
5. **"Overlays cannot add outcomes" will hurt.** One tenant with a genuinely unique business answer
   forces a contract bump that ripples to every other tenant's callers. I accept it because the
   alternative — a caller receiving an outcome it has never heard of, at one institution only — is
   worse. It is still the constraint most likely to be relitigated in production.
6. **`suspended` holds a live session across an agent turn.** That costs a browser or pty per parked
   run and adds a way to fail: the underlying session can expire while suspended. The lease TTL and
   `intervention.expiresAt` bound it, and resume re-verifies the step precondition rather than
   continuing into a stale page — but a long human response time converts a suspension into a
   failure, and callers must be told that.
7. **Digest-and-signature assumes a key custody story this design does not build.** Approval signing
   is only as good as the key management around it, which is out of scope here and would not be in
   production.
8. **Regex in detectors and parsers is an attack surface.** Length caps, a compile-time linter and
   capped input mitigate it. They do not eliminate it, and the safest version of this design would
   drop `regex` from `TextMatchMode` entirely and accept less expressive detectors.
