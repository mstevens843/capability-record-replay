/**
 * Reference implementation of the browser Surface driver's perceive().
 * Builds one normalised Observation across a frameset, from the CDP accessibility
 * tree only. No CSS selectors anywhere.
 */
const ACTIONABLE = new Set(['button','link','textbox','combobox','checkbox','radio','menuitem','tab','option','searchbox','slider','spinbutton','switch','listbox']);

export async function attach(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Accessibility.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');
  return cdp;
}

/** Enumerate every frame reachable from the page target, in tree order. */
async function frameTree(cdp) {
  const { frameTree: ft } = await cdp.send('Page.getFrameTree');
  const out = [];
  (function walk(node, path) {
    const name = node.frame.name ?? '';
    const here = [...path, name || `#${out.length}`];
    out.push({ id: node.frame.id, name, url: node.frame.url, path: here });
    for (const c of node.childFrames ?? []) walk(c, here);
  })(ft, []);
  return out;
}

const STATE_PROPS = new Set(['disabled','checked','selected','expanded','focused','readonly','required','invalid','multiselectable','hasPopup','level','pressed']);

/** geometry: 'actionable' (default) | 'all' | 'none'. Each box is one CDP round trip. */
export async function perceive(cdp, { geometry = 'actionable' } = {}) {
  const frames = await frameTree(cdp);
  const nodes = [];
  const byGlobalId = new Map();

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    let axNodes;
    try { ({ nodes: axNodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: f.id })); }
    catch { continue; }                       // OOPIF: not reachable from this session
    const local = new Map(axNodes.map(n => [n.nodeId, n]));

    for (const n of axNodes) {
      const roleVal = n.role?.value;
      if (!roleVal) continue;
      // role.type === 'internalRole' means Blink's internal role (LayoutTable, GenericContainer, …)
      // role.type === 'role'         means a real ARIA role. The distinction is the whole point.
      const isAria = n.role.type === 'role';
      const state = {};
      for (const p of n.properties ?? []) if (STATE_PROPS.has(p.name)) state[p.name] = p.value?.value;
      const parentLocal = n.parentId ? local.get(n.parentId) : undefined;
      const node = {
        id: `f${fi}:${n.nodeId}`,                  // frame-namespaced; AX nodeIds are per-document
        backendDOMNodeId: n.backendDOMNodeId,
        role: roleVal,
        ariaRole: isAria ? roleVal : null,          // null => layout/presentational, not a real control
        name: n.name?.value ?? '',
        value: n.value?.value ?? null,
        ignored: !!n.ignored,
        state,
        frameIndex: fi,
        containerPath: f.path,                      // e.g. ['#0','content'] — which frame it lives in
        parentId: n.parentId ? `f${fi}:${n.parentId}` : null,
        childIds: (n.childIds ?? []).map(c => `f${fi}:${c}`),
        bounds: null,
      };
      nodes.push(node);
      byGlobalId.set(node.id, node);
    }
  }

  // Stitch: an AX "Iframe" leaf in one document is the parent of another document's root.
  for (const n of nodes) {
    if (n.role !== 'Iframe' && n.role !== 'iframe') continue;
    const { node: dom } = await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
    if (!dom.frameId) continue;
    const childIdx = frames.findIndex(f => f.id === dom.frameId);
    if (childIdx < 0) continue;
    const childRoot = nodes.find(x => x.frameIndex === childIdx && x.parentId === null);
    if (!childRoot) continue;
    childRoot.parentId = n.id;
    n.childIds = [childRoot.id];
  }

  // Geometry. One CDP round trip per node, so only take it for nodes we might act on.
  const wants = geometry === 'none' ? []
    : geometry === 'all' ? nodes
    : nodes.filter(n => ACTIONABLE.has(n.ariaRole) || ['cell','columnheader','row','dialog','alertdialog'].includes(n.ariaRole));
  for (const n of wants) {
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
      // border quad, main-frame viewport CSS px — this is what page.mouse consumes.
      n.bounds = { x: model.border[0], y: model.border[1], w: model.border[2]-model.border[0], h: model.border[7]-model.border[1] };
    } catch { n.bounds = null; }               // display:none, detached, or no layout box
  }
  return { frames, nodes, byGlobalId };
}

/** "the cell in the row whose <key column> is X" — pure function over the Observation. */
export function cellInRowWhere(obs, { keyValue, columnLabel }) {
  const cells = obs.nodes.filter(n => n.ariaRole === 'cell' && n.name.trim() === keyValue);
  if (cells.length === 0) return { kind: 'NOT_FOUND', keyValue };
  if (cells.length > 1)  return { kind: 'AMBIGUOUS', keyValue, count: cells.length };
  const cell = cells[0];
  const up = (n) => n.parentId ? obs.byGlobalId.get(n.parentId) : null;
  let row = up(cell); while (row && row.ariaRole !== 'row') row = up(row);
  if (!row) return { kind: 'NO_ROW', keyValue };
  const isCell = n => n.ariaRole === 'cell' || n.ariaRole === 'columnheader' || n.ariaRole === 'rowheader';
  const collect = (n, out = []) => { for (const id of n.childIds) { const k = obs.byGlobalId.get(id); if (!k) continue; if (isCell(k)) out.push(k); else collect(k, out); } return out; };
  const rowCells = collect(row);
  let table = up(row); while (table && table.ariaRole !== 'table') table = up(table);
  const tableRows = (function rows(n, out = []) { for (const id of n.childIds) { const k = obs.byGlobalId.get(id); if (!k) continue; if (k.ariaRole === 'row') out.push(k); else rows(k, out); } return out; })(table);
  const headerCells = collect(tableRows[0]);
  const headersAreReal = headerCells.length > 0 && headerCells.every(h => h.ariaRole === 'columnheader');
  const col = headerCells.findIndex(h => h.name.trim() === columnLabel);
  if (col < 0) return { kind: 'NO_SUCH_COLUMN', columnLabel, available: headerCells.map(h => h.name) };
  return {
    kind: 'OK', keyValue, columnLabel,
    headerProvenance: headersAreReal ? 'columnheader-role' : 'first-row-heuristic',
    keyColumnIndex: rowCells.indexOf(cell),
    cell: rowCells[col],
    rowCells: rowCells.map(c => c.name),
  };
}
