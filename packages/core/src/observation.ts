// SPEC section 2.2 - the only place surfaces and flows meet, expressed as data.
//
// The `Surface` port itself (three async methods) belongs to the ports unit; what is here is every
// VALUE that crosses it. They are schemas rather than bare interfaces for one reason that pays for
// itself immediately: SPEC section 4.8 says a production failure becomes a `classify()` unit test
// by saving the `Observation` that produced it, with no browser and no reproduction step. That only
// works if an `Observation` can be read back off disk and validated, which requires a validator.
//
// Nothing in this file knows what a browser is. The words that would give it away are refused
// repo-wide by the contract test in SPEC section 1.3.

import { z } from "zod";
import { DescriptorKindSchema } from "./descriptor-kinds.js";
import {
  type DeepReadonly,
  DigestSchema,
  EvidenceRefSchema,
  NodeIdSchema,
  RoleSchema,
  SurfaceKindSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

// ---------------------------------------------------------------------------------------------
// Where a route lands
// ---------------------------------------------------------------------------------------------

/** A symbolic origin - `corebank` - resolved to a real host per tenant by the overlay. */
export const OriginAliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, { error: "an origin alias is a symbolic name, not a host" })
  .max(64);

const routeLocationSchemaImpl = z.strictObject({
  originAlias: OriginAliasSchema,
  path: z.string().startsWith("/", { error: "a route path is absolute" }).max(512),
  query: z.record(z.string().min(1), z.string()),
  frame: z.string().min(1).max(128).optional(),
});
/**
 * A canonicalized location. Never a raw URL: the driver applies the tenant's route
 * canonicalization before it builds an `Observation`, so an observation on disk cannot carry a
 * member number in a path - which is what makes the frozen-observation corpus safe to commit.
 */
export interface RouteLocationSchemaType extends SchemaIdentity<typeof routeLocationSchemaImpl> {}
export const RouteLocationSchema: RouteLocationSchemaType = routeLocationSchemaImpl;

export type RouteLocation = DeepReadonly<z.infer<typeof RouteLocationSchema>>;

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

export const ContainerKindSchema = z.enum([
  "frame",
  "landmark",
  "heading-section",
  "table",
  "screen",
]);
export type ContainerKind = z.infer<typeof ContainerKindSchema>;

export const LandmarkRoleSchema = z.enum(["main", "navigation", "form", "region", "dialog"]);
export type LandmarkRole = z.infer<typeof LandmarkRoleSchema>;

export const HeadingLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type HeadingLevel = z.infer<typeof HeadingLevelSchema>;

const containerSegmentSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("frame"), name: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("landmark"),
    role: LandmarkRoleSchema,
    name: z.string().max(256).nullable(),
  }),
  z.strictObject({
    kind: z.literal("heading-section"),
    heading: z.string().max(256),
    level: HeadingLevelSchema,
  }),
  z.strictObject({
    kind: z.literal("table"),
    headers: z.array(z.string().max(128)).max(64).readonly(),
  }),
  /** The terminal surface's URL: the screen id read off the fixed header or footer band. */
  z.strictObject({ kind: z.literal("screen"), id: z.string().min(1).max(64) }),
]);
/**
 * One step of the breadcrumb a node sits under.
 *
 * The `table` segment identifies a table by its COLUMN HEADER SET, which reads like a strange
 * choice until you have looked at a table-soup layout: there is no caption, no id and no class
 * worth trusting, and the set of column headings is both what a human uses to know which table
 * they are looking at and what would have to change for the human workflow to change.
 */
export interface ContainerSegmentSchemaType
  extends SchemaIdentity<typeof containerSegmentSchemaImpl> {}
export const ContainerSegmentSchema: ContainerSegmentSchemaType = containerSegmentSchemaImpl;

export type ContainerSegment = DeepReadonly<z.infer<typeof ContainerSegmentSchema>>;

export const ContainerPathSchema = z.array(ContainerSegmentSchema).max(16).readonly();

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

const nodeStateSchemaImpl = z.strictObject({
  disabled: z.boolean(),
  focused: z.boolean(),
  visible: z.boolean(),
  /** Tristate on a browser. `null` means the surface has no opinion, not `false`. */
  checked: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  selected: z.boolean().nullable(),
  required: z.boolean().nullable(),
  invalid: z.boolean().nullable(),
  readonly: z.boolean().nullable(),
});
export interface NodeStateSchemaType extends SchemaIdentity<typeof nodeStateSchemaImpl> {}
export const NodeStateSchema: NodeStateSchemaType = nodeStateSchemaImpl;

export type NodeState = DeepReadonly<z.infer<typeof NodeStateSchema>>;

/** `keyof NodeState`, as a value, so the `node-state` predicate can name a field. */
export const NODE_STATE_KEYS = [
  "disabled",
  "focused",
  "visible",
  "checked",
  "expanded",
  "selected",
  "required",
  "invalid",
  "readonly",
] as const;
export const NodeStateKeySchema = z.enum(NODE_STATE_KEYS);
export type NodeStateKey = z.infer<typeof NodeStateKeySchema>;

const boundsSchemaImpl = z.strictObject({
  x: z.int(),
  y: z.int(),
  w: z.int().nonnegative(),
  h: z.int().nonnegative(),
  unit: z.enum(["px", "cell"]),
});
export interface BoundsSchemaType extends SchemaIdentity<typeof boundsSchemaImpl> {}
export const BoundsSchema: BoundsSchemaType = boundsSchemaImpl;

export type Bounds = DeepReadonly<z.infer<typeof BoundsSchema>>;

const tablePositionSchemaImpl = z.strictObject({
  rowIndex: z.int().nonnegative(),
  colIndex: z.int().nonnegative(),
  rowHeader: z.string().max(256).nullable(),
  colHeader: z.string().max(256).nullable(),
  /**
   * The difference between "the app told us this column is Share Balance" and "we guessed from row
   * zero". A legacy grid with no header row gives structure for free and headers only by
   * heuristic, and a per-tenant overlay is exactly where a wrong guess gets corrected - which is
   * only possible if the guess was recorded as a guess.
   */
  headerProvenance: z.enum(["columnheader-role", "first-row-heuristic"]),
});
export interface TablePositionSchemaType extends SchemaIdentity<typeof tablePositionSchemaImpl> {}
export const TablePositionSchema: TablePositionSchemaType = tablePositionSchemaImpl;

export type TablePosition = DeepReadonly<z.infer<typeof TablePositionSchema>>;

const uINodeSchemaImpl = z.strictObject({
  id: NodeIdSchema,
  /** The driver's raw role name, including the structural and internal ones. Kept because folding
   *  a layout table into a real table is what makes "the row whose Member ID is X" resolve to
   *  three elements instead of one. */
  rawRole: z.string().min(1).max(64),
  /** The normalized role, or `null` for a structural node. Only non-null nodes are candidate
   *  targets, and that single field is the whole difference on a table-based layout. */
  ariaRole: RoleSchema.nullable(),
  name: z.string().max(1024),
  value: z.string().max(4096).nullable(),
  text: z.string().max(4096).nullable(),
  description: z.string().max(1024).nullable(),
  state: NodeStateSchema,
  bounds: BoundsSchema.nullable(),
  containerPath: ContainerPathSchema,
  parent: NodeIdSchema.nullable(),
  children: z.array(NodeIdSchema).readonly(),
  labelledBy: z.array(NodeIdSchema).readonly(),
  tablePosition: TablePositionSchema.nullable(),
  /** Field width in cells on a character grid; `null` on a browser. This is where a capability's
   *  typed `maxLength` comes from when the surface knows it. */
  capacity: z.int().positive().nullable(),
  /** The driver's confidence in its own synthesis, compared against the surface's
   *  `confidenceFloor` during quorum. 1.0 for a labelled node in a real accessibility tree; lower
   *  where a role was inferred from a reverse-video run on a character grid. */
  confidence: z.number().min(0).max(1),
  /** Text that changes on its own. Excluded from the skeleton digest, so a clock in a page header
   *  cannot make a surface permanently unsettled. */
  live: z.boolean(),
  /** True when the driver blanked this value because it is bound to a sensitive parameter. */
  masked: z.boolean(),
});
export interface UINodeSchemaType extends SchemaIdentity<typeof uINodeSchemaImpl> {}
export const UINodeSchema: UINodeSchemaType = uINodeSchemaImpl;

export type UINode = DeepReadonly<z.infer<typeof UINodeSchema>>;

// ---------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------

const stabilitySchemaImpl = z.strictObject({
  settled: z.boolean(),
  generation: z.int().nonnegative(),
  pendingReason: z.enum(["navigating", "network", "animating", "pty-active", "unknown"]).nullable(),
});
export interface StabilitySchemaType extends SchemaIdentity<typeof stabilitySchemaImpl> {}
export const StabilitySchema: StabilitySchemaType = stabilitySchemaImpl;

export type Stability = DeepReadonly<z.infer<typeof StabilitySchema>>;

const nativeDialogSchemaImpl = z.strictObject({
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(4096),
  defaultValue: z.string().max(4096).nullable(),
});
/**
 * A native dialog is a SEPARATE CHANNEL, not a node.
 *
 * The browser spike is unambiguous about why: a native confirm is invisible to the accessibility
 * tree entirely, so it cannot be modelled as a `UINode`, and a boolean "input is intercepted"
 * cannot carry the message text - which is exactly what you need in order to decide accept versus
 * dismiss. It is also what blocks the renderer, which is why `perceive` needs a deadline of its own.
 */
export interface NativeDialogSchemaType extends SchemaIdentity<typeof nativeDialogSchemaImpl> {}
export const NativeDialogSchema: NativeDialogSchemaType = nativeDialogSchemaImpl;

export type NativeDialog = DeepReadonly<z.infer<typeof NativeDialogSchema>>;

const observationSchemaImpl = z.strictObject({
  /** Monotonic within a session, and deliberately NOT a timestamp: the classifier gets no clock. */
  seq: z.int().nonnegative(),
  surface: z.strictObject({ kind: SurfaceKindSchema, driver: z.string().min(1).max(128) }),
  route: RouteLocationSchema.nullable(),
  /** Flat with parent links rather than a tree. A flat array is faster to scan and much easier to
   *  write a TOTAL predicate over, and totality is a stated property of the classifier. */
  nodes: z.array(UINodeSchema).readonly(),
  /** Plural: a frameset has several. */
  roots: z.array(NodeIdSchema).readonly(),
  /**
   * Digest of the structural skeleton only - role, accessible name, container path and state -
   * excluding geometry and excluding `live` nodes. Computed by the DRIVER, so the classifier never
   * hashes anything. Typed as a plain string rather than a `Digest` because it is the driver's
   * own summary and not a content address any signature is taken over.
   */
  skeletonDigest: z.string().min(1).max(128),
  stability: StabilitySchema,
  nativeDialog: NativeDialogSchema.nullable(),
  /** True when the driver knows something is intercepting input. Drives the pre-act guard. */
  inputIntercepted: z.boolean(),
});
export interface ObservationSchemaType extends SchemaIdentity<typeof observationSchemaImpl> {}
export const ObservationSchema: ObservationSchemaType = observationSchemaImpl;

export type Observation = DeepReadonly<z.infer<typeof ObservationSchema>>;

export const PerceiveFaultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("perceive-timeout"), elapsedMs: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("unperceivable-container"), detail: z.string().max(1024) }),
  z.strictObject({ kind: z.literal("surface-error"), message: z.string().max(2048) }),
]);
export type PerceiveFault = DeepReadonly<z.infer<typeof PerceiveFaultSchema>>;

const perceiveResultSchemaImpl = z.union([
  z.strictObject({ ok: z.literal(true), observation: ObservationSchema }),
  z.strictObject({ ok: z.literal(false), fault: PerceiveFaultSchema }),
]);
export interface PerceiveResultSchemaType extends SchemaIdentity<typeof perceiveResultSchemaImpl> {}
export const PerceiveResultSchema: PerceiveResultSchemaType = perceiveResultSchemaImpl;

export type PerceiveResult = DeepReadonly<z.infer<typeof PerceiveResultSchema>>;

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/**
 * The PORT's key vocabulary, F1-F12 included.
 *
 * The artifact's vocabulary (`ArtifactKey`) deliberately excludes them. On a green screen the
 * function keys are the submit mechanism, so a port without them cannot express that surface at
 * all - but the terminal spike measured the same Exit control bound to F3 at one tenant and F12 at
 * the next while the synthesized node was identical across both. So the keys live here, where the
 * driver can lower an `activate` onto whichever one the legend line says, and not in the program.
 */
export const KeySchema = z.enum([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);
export type Key = z.infer<typeof KeySchema>;

export const ActionKindSchema = z.enum([
  "click",
  "type",
  "select",
  "setChecked",
  "pressKey",
  "focus",
  "navigate",
  "acceptDialog",
  "dismissDialog",
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

const actionSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), target: NodeIdSchema }),
  z.strictObject({
    kind: z.literal("type"),
    target: NodeIdSchema,
    text: z.string(),
    mode: z.literal("replace"),
    sensitive: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("select"), target: NodeIdSchema, option: z.string() }),
  z.strictObject({ kind: z.literal("setChecked"), target: NodeIdSchema, checked: z.boolean() }),
  z.strictObject({
    kind: z.literal("pressKey"),
    target: NodeIdSchema.nullable(),
    key: KeySchema,
  }),
  z.strictObject({ kind: z.literal("focus"), target: NodeIdSchema }),
  z.strictObject({ kind: z.literal("navigate"), route: RouteLocationSchema }),
  z.strictObject({ kind: z.literal("acceptDialog"), text: z.string().nullable() }),
  z.strictObject({ kind: z.literal("dismissDialog") }),
]);
/**
 * The driver-facing action. It names a resolved `NodeId`, never a descriptor - resolution has
 * already happened by the time anything gets here.
 *
 * Note what is absent: no `wait`, no `screenshot`, no `read`, no `scroll`, no `evaluate`. Waiting
 * is the executor's quiescence loop. Reading is a pure function over an `Observation`, which is
 * what lets extraction be tested from a frozen snapshot. Making a node actionable is the surface's
 * obligation before it acts, so scrolling as an instruction would hardcode a browser assumption
 * into a language that also runs on a character grid. And an `evaluate` would be a hole straight
 * through both the surface abstraction and the single policy chokepoint.
 */
export interface ActionSchemaType extends SchemaIdentity<typeof actionSchemaImpl> {}
export const ActionSchema: ActionSchemaType = actionSchemaImpl;

export type Action = DeepReadonly<z.infer<typeof ActionSchema>>;

const actFaultSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lease-not-held") }),
  z.strictObject({ kind: z.literal("node-gone"), nodeId: NodeIdSchema }),
  z.strictObject({
    kind: z.literal("not-actionable"),
    nodeId: NodeIdSchema,
    why: z.enum(["disabled", "invisible", "zero-size", "off-screen-unscrollable"]),
  }),
  z.strictObject({ kind: z.literal("intercepted"), nodeId: NodeIdSchema }),
  z.strictObject({ kind: z.literal("navigation-blocked"), route: z.string().max(512) }),
  z.strictObject({ kind: z.literal("surface-error"), message: z.string().max(2048) }),
]);
/**
 * MECHANICAL faults only. The driver reports what the machinery did; it never classifies. Turning
 * one of these into a `FailureClass` needs the artifact's context, and that is the classifier's
 * job - which is the same rule the terminal driver follows when it reports a "no member on file"
 * banner as a `status` node and stops.
 */
export interface ActFaultSchemaType extends SchemaIdentity<typeof actFaultSchemaImpl> {}
export const ActFaultSchema: ActFaultSchemaType = actFaultSchemaImpl;

export type ActFault = DeepReadonly<z.infer<typeof ActFaultSchema>>;

export const ActFaultKindSchema = z.enum([
  "lease-not-held",
  "node-gone",
  "not-actionable",
  "intercepted",
  "navigation-blocked",
  "surface-error",
]);
export type ActFaultKind = z.infer<typeof ActFaultKindSchema>;

const actResultSchemaImpl = z.union([
  z.strictObject({ ok: z.literal(true), dispatched: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), fault: ActFaultSchema }),
]);
export interface ActResultSchemaType extends SchemaIdentity<typeof actResultSchemaImpl> {}
export const ActResultSchema: ActResultSchemaType = actResultSchemaImpl;

export type ActResult = DeepReadonly<z.infer<typeof ActResultSchema>>;

// ---------------------------------------------------------------------------------------------
// Capture and capabilities
// ---------------------------------------------------------------------------------------------

const captureRequestSchemaImpl = z.strictObject({
  /** Regions blanked BEFORE the bytes exist. Not applied afterwards: a screenshot that was ever
   *  unmasked in memory is a screenshot that can leak. */
  maskRegions: z
    .array(
      z.strictObject({
        x: z.int(),
        y: z.int(),
        w: z.int().nonnegative(),
        h: z.int().nonnegative(),
      }),
    )
    .readonly(),
  format: z.enum(["image", "text-grid"]),
});
export interface CaptureRequestSchemaType extends SchemaIdentity<typeof captureRequestSchemaImpl> {}
export const CaptureRequestSchema: CaptureRequestSchemaType = captureRequestSchemaImpl;

export type CaptureRequest = DeepReadonly<z.infer<typeof CaptureRequestSchema>>;

const captureSchemaImpl = z.strictObject({
  ref: EvidenceRefSchema,
  digest: DigestSchema,
  maskedRegions: z.int().nonnegative(),
});
export interface CaptureSchemaType extends SchemaIdentity<typeof captureSchemaImpl> {}
export const CaptureSchema: CaptureSchemaType = captureSchemaImpl;

export type Capture = DeepReadonly<z.infer<typeof CaptureSchema>>;

export const SurfaceFeatureSchema = z.enum([
  "accessibility-tree",
  "table-position",
  "containers",
  "geometry",
  "character-grid",
  "route",
  "native-dialog-channel",
]);
export type SurfaceFeature = z.infer<typeof SurfaceFeatureSchema>;

const surfaceCapabilitiesSchemaImpl = z.strictObject({
  kind: SurfaceKindSchema,
  driver: z.string().min(1).max(128),
  supportedActions: z.array(ActionKindSchema).readonly(),
  supportedKeys: z.array(KeySchema).readonly(),
  supportedRoles: z.array(RoleSchema).readonly(),
  resolvableDescriptors: z.array(DescriptorKindSchema).readonly(),
  containerKinds: z.array(ContainerKindSchema).readonly(),
  boundsUnit: z.enum(["px", "cell"]).nullable(),
  /** The minimum synthesis confidence a descriptor must clear on this surface to count toward a
   *  quorum. 1.0 on a real accessibility tree; lower where roles are inferred. */
  confidenceFloor: z.number().min(0).max(1),
  canCapture: z.array(z.enum(["image", "text-grid"])).readonly(),
});
/**
 * Advertised at LOAD time, so the linker can refuse a program this surface cannot run before a
 * browser is launched or a pty is spawned. "This program needs a descriptor kind this surface
 * cannot resolve" is a load-time message; without this it is a mysterious `target-not-found` six
 * steps in, at which point somebody is reading a journal at 2am.
 */
export interface SurfaceCapabilitiesSchemaType
  extends SchemaIdentity<typeof surfaceCapabilitiesSchemaImpl> {}
export const SurfaceCapabilitiesSchema: SurfaceCapabilitiesSchemaType =
  surfaceCapabilitiesSchemaImpl;

export type SurfaceCapabilities = DeepReadonly<z.infer<typeof SurfaceCapabilitiesSchema>>;
