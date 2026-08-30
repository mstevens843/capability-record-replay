# Desktop Automation Design

Status: design only. There is no verified desktop surface in this repository, and no submission
claim depends on one.

## Goal

Add a desktop `Surface` adapter without weakening the current thesis:

- the artifact stays data, not generated executable code;
- replay remains deterministic and model-free;
- desktop observations become the same `Observation` shape the classifier already consumes;
- irreversible desktop actions use the same policy and invocation-approval gates as browser and
  terminal actions.

## Platform Mapping

macOS would use Accessibility (AX). Windows would use UI Automation (UIA). Both expose a tree of
windows and controls with role/control type, name, value, enabled state, focus state, bounds, and
supported action patterns.

The adapter maps those platform records into `UINode`:

| Observation field | macOS AX source | Windows UIA source |
|---|---|---|
| `ariaRole` | AX role/subrole normalized to CRR role vocabulary | ControlType normalized to CRR role vocabulary |
| `name` | `AXTitle`, `AXDescription`, labelled-by relation when available | `Name`, labelled-by relation when available |
| `value` | `AXValue` when readable and safe | `ValuePattern.Value` when readable and safe |
| `enabled` | `AXEnabled` | `IsEnabled` |
| `visible` | window/display intersection plus hidden/minimized checks | offscreen/minimized/window intersection checks |
| `containerPath` | app -> window -> group/dialog/table | process/app -> window -> pane/dialog/table |
| `boundsBucket` | quantized AX frame | quantized bounding rectangle |

The route equivalent is not a URL. It is a stable application/window state descriptor:
application bundle id or executable identity, top-level window title pattern after redaction, and a
screen/state id declared by the artifact when the UI exposes one. If the adapter cannot derive a
route without sensitive data, route is `null` and the artifact must use stronger preconditions.

## Stable Descriptors

Use the same evidence rule as the browser and terminal surfaces: one descriptor is not enough when
an action matters.

Preferred desktop descriptors:

- role plus accessible name;
- label-anchored field relation;
- table/list cell by row key and column header;
- dialog/window name inside an app identity;
- ordinal only inside a strongly named container, and never as the sole independent source;
- quantized geometry only as secondary evidence.

Avoid relying on raw AX ids, UIA runtime ids, process-local handles, coordinates, OCR text, or
vendor automation ids as a sole action identity. They may be recorded as provenance or drift
signals, but not as the primary proof of target identity.

## Focus and Actionability

Before every desktop action, the adapter must:

1. verify the automation lease;
2. verify the foreground application/window or explicitly bring the leased window forward;
3. re-perceive the target and run the resolver;
4. check enabled, visible, unoccluded enough to act, and not inside an unrelated modal;
5. for text input, focus the field, confirm focus landed on the same resolved node, then type;
6. after action, wait for platform events plus a bounded quiet window, then run the normal
   checkpoint.

Focus changes are treated as observable effects, not assumptions. A click that moves focus to a
different field is a target/refusal case, not a best-effort action.

## Lease Enforcement

The desktop surface must enforce the same lease rule as the existing port:

- `perceive()` can read the leased session;
- `act(action, lease)` must refuse when the lease is absent, stale, or no longer owns the foreground
  window;
- human takeover breaks or suspends the lease;
- resume must re-run route, continuity, target, policy, and approval checks before dispatch.

The lease is intentionally outside the model. It is runtime/session state.

## Capture, Masking, and Redaction

Desktop capture would support two levels:

- structured observation capture, redacted by existing taint bindings before it is written;
- optional screenshot capture, masked by regions derived from sensitive input bindings and sensitive
  output nodes.

Masking must happen before bytes leave the adapter. Screenshots may contain native text rendering,
tooltips, window titles, clipboard suggestions, or password-manager overlays; the canary has to scan
the finished evidence bundle just as it does for browser evidence.

## Approval Boundaries

Desktop actions inherit the artifact step effect class:

- navigation and observation stay `READ`;
- filling a form, changing a selection, or staging a reversible setting is
  `WRITE_REVERSIBLE` when the target app offers a reliable undo/cancel boundary;
- pressing Apply, Save, Submit, Delete, Send, Transfer, or any platform action that commits outside
  the current form is `WRITE_IRREVERSIBLE`.

The interpreter already enforces invocation approval before `WRITE_IRREVERSIBLE`. A desktop adapter
must not implement its own approval logic and must not dispatch an irreversible native action until
the interpreter has accepted approval.

## Verified Toy Spike Requirements

A defensible spike would need a local toy app on each platform, not a real banking or enterprise
application. Minimum proof:

- capture AX/UIA observations into the existing `Observation` schema;
- drive a read-only flow and a reversible form flow;
- prove one final irreversible button stops without invocation approval;
- prove a valid invocation approval dispatches exactly once;
- prove wrong-target and modal-interception failures;
- prove screenshot/observation redaction with canary values;
- run the same classifier and interpreter code as browser and terminal.

Until those exist and pass locally, desktop support remains design-only.
