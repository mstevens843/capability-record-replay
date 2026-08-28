// The slice of the Chrome DevTools Protocol this driver reads, written as local structural types.
//
// WHY these are hand-written rather than imported. Playwright types `CDPSession.send` against its
// own bundled `Protocol` namespace, so every call site is already checked - but `Protocol` lives at
// `playwright-core/types/protocol`, which is not in that package's `exports` map and is therefore
// not importable by name. Declaring the fields we consume gives the helper functions below real
// signatures, and the assignment at the call site (`const nodes: readonly AxNode[] = result.nodes`)
// is what checks our declaration against Playwright's: widen a field wrongly and it stops
// compiling, which is exactly the drift we want caught.
//
// Everything here is READ-ONLY and deliberately loose about `value`. `AXValue.value` is `any` in the
// protocol - it carries a string for `name`, a boolean for `focusable`, the literal strings
// `"true"`/`"false"`/`"mixed"` for `checked` (browser spike section 5.4) - so it is typed `unknown`
// and narrowed at the one place that reads it.

/** One `AXValue`. `type` distinguishes an ARIA role from a Chromium-internal one - the single
 *  distinction driver rule D2 rests on. */
export interface AxValue {
  readonly type: string;
  readonly value?: unknown;
  readonly relatedNodes?: readonly AxRelatedNode[];
}

export interface AxRelatedNode {
  readonly backendDOMNodeId?: number;
  readonly idref?: string;
  readonly text?: string;
}

export interface AxProperty {
  readonly name: string;
  readonly value: AxValue;
}

/**
 * One accessibility node as `Accessibility.getFullAXTree` returns it.
 *
 * Two fields are load-bearing and easy to misread:
 *   · `nodeId` is unique only WITHIN one document, so it is namespaced per frame before it becomes
 *     a `NodeId`.
 *   · `backendDOMNodeId` is unique across the whole page and is the identity geometry and actions
 *     are keyed on - but it is OPTIONAL, and the nodes that lack it (`InlineTextBox`) cannot be
 *     measured or acted on at all, which is why they are dropped rather than carried.
 */
export interface AxNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly description?: AxValue;
  readonly properties?: readonly AxProperty[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
  /** Present on frame ROOT nodes only. Six of the seven nodes in a frameset's own tree have none,
   *  which is why "walk up parentId until you find a frameId" is not a way to tell frames apart. */
  readonly frameId?: string;
}

/** The four quads `DOM.getBoxModel` returns. Only `border` is used: it is what
 *  `locator.boundingBox()` reports, and the `content` quad excludes padding, so on a legacy toolbar
 *  button that is mostly padding the content centre can land on the container instead. */
export interface BoxModel {
  readonly content: readonly number[];
  readonly padding: readonly number[];
  readonly border: readonly number[];
  readonly margin: readonly number[];
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------------------------
// Reading an AXValue
// ---------------------------------------------------------------------------------------------

/** The string an `AXValue` carries, or `""`. Numbers and booleans are stringified rather than
 *  dropped: `value` on a spinbutton is a number and a person still reads it as text. */
export function axString(value: AxValue | undefined): string {
  const raw = value?.value;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/**
 * The tristate an AX property carries.
 *
 * `checked` comes back as the STRINGS `"true"` / `"false"` / `"mixed"`, not as a boolean (browser
 * spike section 5.4). Truth-testing it makes every checkbox on the page look checked, because
 * `"false"` is a non-empty string.
 */
export function axTristate(value: AxValue | undefined): boolean | null {
  const raw = value?.value;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Property lookup by name. Properties are a small unordered list on each node, so a linear scan
 *  is both the simplest and the fastest thing available. */
export function axProperty(node: AxNode, name: string): AxValue | undefined {
  for (const property of node.properties ?? []) {
    if (property.name === name) return property.value;
  }
  return undefined;
}
