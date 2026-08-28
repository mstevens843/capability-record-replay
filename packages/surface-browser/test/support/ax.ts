// A tiny builder for `AxNode` fixtures, so the normalization tests read like the tree they describe.
//
// The whole point of the pure/impure split in this package is that the decisions that have to be
// RIGHT - which nodes are targets, which row a cell is in, what a breadcrumb says - are testable
// from a frozen array with no browser running. That only pays off if writing the frozen array is
// cheap, which is what this file is for.

import type { AxNode, AxProperty } from "../../src/cdp.js";

export interface AxSpec {
  readonly id: string;
  readonly role: string;
  /** `"role"` for an ARIA role, `"internalRole"` for one of Chromium's own. Defaults to `"role"`. */
  readonly type?: "role" | "internalRole";
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly parent?: string;
  readonly children?: readonly string[];
  readonly ignored?: boolean;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Omit to have the node carry NO backend id - which is how Chromium reports an `InlineTextBox`
   *  and is the condition this driver drops a node on. Defaults to the numeric part of `id`. */
  readonly backend?: number | null;
  /** Set on frame ROOT nodes only, exactly as Chromium does. */
  readonly frameId?: string;
  readonly labelledBy?: readonly number[];
}

export function ax(spec: AxSpec): AxNode {
  const properties: AxProperty[] = Object.entries(spec.properties ?? {}).map(([name, value]) => ({
    name,
    value: { type: typeof value === "boolean" ? "booleanOrUndefined" : "string", value },
  }));
  if (spec.labelledBy !== undefined) {
    properties.push({
      name: "labelledby",
      value: {
        type: "nodeList",
        relatedNodes: spec.labelledBy.map((backendDOMNodeId) => ({ backendDOMNodeId })),
      },
    });
  }
  const backend =
    spec.backend === null
      ? undefined
      : (spec.backend ?? Number.parseInt(spec.id.replace(/\D/g, ""), 10));
  return {
    nodeId: spec.id,
    ignored: spec.ignored ?? false,
    role: { type: spec.type ?? "role", value: spec.role },
    name: spec.name === undefined ? undefined : { type: "computedString", value: spec.name },
    value: spec.value === undefined ? undefined : { type: "string", value: spec.value },
    description:
      spec.description === undefined ? undefined : { type: "string", value: spec.description },
    properties: properties.length > 0 ? properties : undefined,
    childIds: spec.children === undefined ? undefined : [...spec.children],
    parentId: spec.parent,
    backendDOMNodeId: backend,
    frameId: spec.frameId,
  };
}

/** A run of rendered text. Chromium's internal role, so it is structure - `ariaRole: null` - and its
 *  `name` IS the text a person reads. */
export const text = (id: string, value: string, parent: string): AxNode =>
  ax({ id, role: "StaticText", type: "internalRole", name: value, parent });
