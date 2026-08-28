// Tiny HTML helpers. No template engine, because a dependency here would be the only dependency in
// the fixture and the markup is supposed to look hand-rolled in 2006 anyway.

/** @param {unknown} value */
export const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Legacy label text: a `<font>` tag, because that is what the surface under test actually uses and
 * a driver that reads the accessibility tree has to cope with it.
 *
 * @param {import("./tenants.js").Tenant} tenant
 * @param {string} text
 * @param {{ size?: string, bold?: boolean, color?: string }} [opts]
 */
export const fnt = (tenant, text, opts = {}) => {
  const size = opts.size ?? "2";
  const color = opts.color ? ` color="${opts.color}"` : "";
  const inner = opts.bold ? `<b>${text}</b>` : text;
  return `<font face="${tenant.fontFace}" size="${size}"${color}>${inner}</font>`;
};

/** Non-breaking-space spacer, the legacy layout primitive. */
export const nbsp = (count = 1) => "&nbsp;".repeat(count);
