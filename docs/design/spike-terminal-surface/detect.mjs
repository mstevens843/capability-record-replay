/*
 * Grid -> typed UINodes ("Observation") for a character-cell surface.
 *
 * A PURE FUNCTION of a frozen Grid snapshot: no I/O, no clock, no terminal handle.
 * That is the whole point - the detector is unit-testable from JSON fixtures, the
 * same way the browser driver's accessibility-tree normalizer is.
 *
 * It reports STRUCTURE only. It never decides that "NO MEMBER ON FILE" means
 * MEMBER_NOT_FOUND; that is the artifact's declared outcome detector's job.
 */

const attrKey = (c) => `${c.inverse ? 1 : 0}${c.bold ? 1 : 0}${c.underline ? 1 : 0}:${c.fg}:${c.bg}`;
const rowText = (g, y) => g.cells[y].map((c) => c.ch).join('');
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s:._>-]+|[\s:._>-]+$/g, '').trim();

/** 1. Segment each row into maximal runs of identical attributes. */
function runs(g) {
  const out = [];
  for (let y = 0; y < g.rows; y++) {
    const text = rowText(g, y);
    let s = 0;
    for (let x = 1; x <= g.cols; x++) {
      if (x === g.cols || attrKey(g.cells[y][x]) !== attrKey(g.cells[y][s])) {
        out.push({ y, x0: s, x1: x - 1, w: x - s, attr: g.cells[y][s], text: text.slice(s, x) });
        s = x;
      }
    }
  }
  return out;
}

/** 2. "Plain" = the attribute covering the most cells. Derived, never hardcoded:
 *     an app may mark fields with reverse video, underline, or colour and the
 *     detector must not care which. */
function plainAttr(g) {
  const t = new Map();
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) {
    const k = attrKey(g.cells[y][x]);
    t.set(k, (t.get(k) || 0) + 1);
  }
  return [...t].sort((a, b) => b[1] - a[1])[0][0];
}

/** 3. Label anchoring: nearest text to the left on the same row within `gap`,
 *     else the text directly above spanning the same columns. */
function labelFor(g, r, gap = 12) {
  const left = rowText(g, r.y).slice(0, r.x0).replace(/\s+$/, '');
  if (left && r.x0 - left.length <= gap) {
    const m = /([A-Za-z][A-Za-z0-9 /#&'.-]*[:.]?)\s*$/.exec(left);
    if (m && clean(m[1])) return { text: clean(m[1]), at: 'left' };
  }
  if (r.y > 0) {
    const above = rowText(g, r.y - 1).slice(r.x0, r.x1 + 1);
    if (clean(above)) return { text: clean(above), at: 'above' };
  }
  return null;
}

/** ATTRIBUTE SEMANTICS - the one place a VT convention is assumed, stated openly:
 *    reverse video   => an operator-writable field, or the selected row of a list
 *    bold/underline  => emphasis: a column header, a screen title, a read-only value
 *  Apps that break this get a per-tenant overlay hint rather than a detector rewrite. */
const isField = (a) => a.inverse;
const isEmph = (a) => !a.inverse && (a.bold || a.underline);

const FKEY = /\b(F\d{1,2}|PF\d{1,2}|ENTER|TAB|ESC|CLEAR)\s*=\s*([A-Za-z][A-Za-z/-]*(?: [A-Za-z/-]+)*)/g;
const bounds = (r) => ({ row0: r.y, row1: r.y, col0: r.x0, col1: r.x1 });
const cursorIn = (g, r) => g.cursor.y === r.y && g.cursor.x >= r.x0 && g.cursor.x <= r.x1 + 1;

export function detect(g, opt = {}) {
  const TITLE_ROWS = opt.titleRows ?? 1;
  const STATUS_ROWS = opt.statusRows ?? 2;
  const WIDE = opt.wideCols ?? Math.max(24, Math.floor(g.cols * 0.35));
  const plain = plainAttr(g);
  const all = runs(g);
  const marked = all.filter((r) => attrKey(r.attr) !== plain && r.w >= 2);
  const body = (r) => r.y >= TITLE_ROWS && r.y < g.rows - STATUS_ROWS;
  const nodes = [];

  // --- screen identity. The bottom band carries the screen name/number on
  //     Episys-shaped apps. It is this surface's equivalent of a URL, and it is
  //     what a checkpoint should anchor on.
  let screenId = null;
  for (let y = g.rows - 1; y >= g.rows - STATUS_ROWS; y--) {
    const t = rowText(g, y).trim();
    if (t) { screenId = t; break; }
  }

  // --- title band: split on 2+ spaces so a banner row yields separate headings.
  for (const r of all) {
    if (r.y >= TITLE_ROWS || !isEmph(r.attr)) continue;
    for (const seg of r.text.split(/\s{2,}/)) {
      if (clean(seg)) nodes.push({ role: 'heading', name: clean(seg), bounds: bounds(r) });
    }
  }

  const emphRuns = marked.filter((r) => body(r) && isEmph(r.attr));

  // A wide reverse-video run is EITHER a wide input field OR the selected row of a
  // list. Width alone cannot tell them apart, so use structure: a list row has no
  // label to its left and has at least one sibling row of data at the same extent.
  const siblingRows = (r) => {
    let n = 0;
    for (const dy of [-1, 1]) {
      const y = r.y + dy;
      if (y < TITLE_ROWS || y >= g.rows - STATUS_ROWS) continue;
      if (rowText(g, y).slice(r.x0, r.x1 + 1).trim()) n++;
    }
    return n;
  };
  const leftLabel = (r) => { const l = labelFor(g, r); return l && l.at === 'left' ? l : null; };
  const looksLikeListRow = (r) => r.w >= WIDE && !leftLabel(r) && siblingRows(r) >= 1;
  const inverseRuns = marked.filter((r) => body(r) && isField(r.attr));
  const selRuns = inverseRuns.filter(looksLikeListRow);
  const fieldRuns = inverseRuns.filter((r) => !looksLikeListRow(r));

  // --- input fields
  for (const r of fieldRuns) {
    const lab = labelFor(g, r);
    nodes.push({
      role: 'textbox',
      name: lab?.text ?? null,
      value: r.text.trim(),
      // `capacity` is the field's declared width. It falls straight out of the
      // grid and becomes the maxLength of the capability's typed parameter.
      capacity: r.w,
      state: { focused: cursorIn(g, r), empty: !r.text.trim() },
      anchor: lab ? { kind: 'label', text: lab.text, at: lab.at } : { kind: 'none' },
      bounds: bounds(r),
    });
  }

  // --- read-only emphasised values ("Member:  12345") vs column headers.
  const headerRows = new Set();
  for (const r of emphRuns) {
    const below = r.y + 1 < g.rows ? rowText(g, r.y + 1).slice(r.x0, r.x1 + 1) : '';
    if (r.w >= WIDE && below.trim()) { headerRows.add(r.y); continue; }
    const lab = labelFor(g, r);
    nodes.push({
      role: 'text', name: lab?.text ?? null, value: r.text.trim(),
      anchor: lab ? { kind: 'label', text: lab.text, at: lab.at } : { kind: 'none' },
      bounds: bounds(r),
    });
  }

  // --- lists. A wide reverse-video run is the SELECTED row; its siblings are the
  //     contiguous rows above/below with the same column extent.
  for (const r of selRuns) {
    const ys = [r.y];
    for (let y = r.y - 1; y >= TITLE_ROWS; y--) {
      if (headerRows.has(y) || !rowText(g, y).slice(r.x0, r.x1 + 1).trim()) break;
      ys.unshift(y);
    }
    for (let y = r.y + 1; y < g.rows - STATUS_ROWS; y++) {
      if (headerRows.has(y) || !rowText(g, y).slice(r.x0, r.x1 + 1).trim()) break;
      ys.push(y);
    }
    const hdrY = ys[0] - 1;
    const hdrRun = headerRows.has(hdrY) ? emphRuns.find((e) => e.y === hdrY) : null;
    // Column boundaries come from the DATA, not from the header text: find the
    // columns that are blank in every row of the block (header included) and treat
    // runs of >=2 of them as gutters. Right-aligned numeric columns overflow their
    // header, so slicing by header width silently truncates values.
    const columns = columnsFromBlock(g, hdrRun ? [hdrY, ...ys] : ys, r.x0, r.x1, hdrRun ? hdrY : null);
    nodes.push({
      role: 'list',
      name: hdrRun ? clean(hdrRun.text) : null,
      columns: columns?.map((c) => c.name) ?? null,
      bounds: { row0: ys[0], row1: ys[ys.length - 1], col0: r.x0, col1: r.x1 },
      children: ys.map((y, i) => ({
        role: 'listitem', index: i,
        text: rowText(g, y).slice(r.x0, r.x1 + 1).trim(),
        cells: columns ? sliceByColumns(rowText(g, y), columns) : null,
        state: { selected: y === r.y, focused: g.cursor.y === y },
        bounds: { row0: y, row1: y, col0: r.x0, col1: r.x1 },
      })),
    });
  }

  // --- function-key legend -> activatable controls. This is what lets an artifact
  //     say `activate control named "Open Suffix"` instead of `send \x1bOR`.
  for (const r of all) {
    if (!body(r)) continue;
    let m; FKEY.lastIndex = 0;
    while ((m = FKEY.exec(r.text)) !== null) {
      nodes.push({
        role: 'button', name: clean(m[2]), key: m[1],
        bounds: { row0: r.y, row1: r.y, col0: r.x0 + m.index, col1: r.x0 + m.index + m[0].length - 1 },
      });
    }
  }

  // --- plain-text "LABEL: value" pairs. Green screens often print read-only values
  //     with no attribute at all, so an attribute-only detector would miss them.
  const covered = (y, a, b) => nodes.some((n) => n.bounds && n.bounds.row0 <= y && n.bounds.row1 >= y && !(n.bounds.col1 < a || n.bounds.col0 > b));
  const LV = /([A-Za-z][A-Za-z0-9 /#&'.-]{1,28}):\s{1,10}(\S(?:[^\s]| (?! ))*)/g;
  for (let y = TITLE_ROWS; y < g.rows - STATUS_ROWS; y++) {
    const line = rowText(g, y);
    let m; LV.lastIndex = 0;
    while ((m = LV.exec(line)) !== null) {
      const a = m.index + m[1].length + 1 + (m[0].length - m[1].length - 1 - m[2].length);
      const b = a + m[2].length - 1;
      if (covered(y, a, b)) continue;
      nodes.push({
        role: 'text', name: clean(m[1]), value: m[2].trim(),
        anchor: { kind: 'label', text: clean(m[1]), at: 'left' },
        bounds: { row0: y, row1: y, col0: a, col1: b },
      });
    }
  }

  // --- status band: TEXT ONLY, no interpretation.
  for (let y = g.rows - STATUS_ROWS; y < g.rows; y++) {
    const t = rowText(g, y).trim();
    if (!t || t === screenId) continue;
    nodes.push({ role: 'status', name: null, value: t, bounds: { row0: y, row1: y, col0: 0, col1: g.cols - 1 } });
  }

  return { screenId, cursor: g.cursor, nodes: nodes.map((n, i, a) => ({ id: mkId(n, a, i), ...n })) };
}

/** Gutter detection over a block of rows. */
function columnsFromBlock(g, ys, x0, x1, headerY) {
  const blank = [];
  for (let x = x0; x <= x1; x++) blank.push(ys.every((y) => (g.cells[y][x]?.ch ?? ' ') === ' '));
  const spans = [];
  let s = null;
  for (let i = 0; i < blank.length; i++) {
    const gutter = blank[i] && blank[i + 1];       // a gutter is >=2 blank columns
    if (!gutter && s === null) s = i;
    if (gutter && s !== null) { spans.push([x0 + s, x0 + i - 1]); s = null; }
  }
  if (s !== null) spans.push([x0 + s, x1]);
  const nonEmpty = spans.filter(([a, b]) => ys.some((y) => g.cells[y].slice(a, b + 1).map((c) => c.ch).join('').trim()));
  if (nonEmpty.length < 2) return null;
  return nonEmpty.map(([a, b], i) => {
    const name = headerY === null ? null : g.cells[headerY].slice(a, b + 1).map((c) => c.ch).join('').trim();
    return { name: name || `col${i + 1}`, col0: a, col1: b };
  });
}

function splitColumns(headerText, offset) {
  const cols = [];
  for (const m of headerText.matchAll(/\S+(?: \S+)*/g)) {
    cols.push({ name: m[0].trim(), col0: offset + m.index, col1: 0 });
  }
  for (let i = 0; i < cols.length; i++) {
    cols[i].col1 = i + 1 < cols.length ? cols[i + 1].col0 - 1 : offset + headerText.replace(/\s+$/, '').length - 1;
  }
  return cols;
}
const sliceByColumns = (line, cols) => Object.fromEntries(cols.map((c) => [c.name, line.slice(c.col0, c.col1 + 1).trim()]));

/** Ids are role + accessible name + ordinal - NEVER coordinates. Coordinates live
 *  in `bounds` and are only ever the lowest-ranked descriptor at resolve time. */
function mkId(n, all, i) {
  const key = (n.name || n.value || 'anon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anon';
  const base = `${n.role}:${key}`;
  const dupes = all.slice(0, i).filter((o) => o.role === n.role && (o.name || o.value || 'anon') === (n.name || n.value || 'anon')).length;
  return dupes ? `${base}#${dupes}` : base;
}
