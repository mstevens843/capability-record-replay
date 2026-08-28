// The hostile markup.
//
// Everything in this file is deliberate. The rules, in one place, so a well-meaning cleanup does not
// quietly destroy the fixture's reason to exist:
//
//   NO test ids. NO `data-*` attributes. NO `<label for>`. NO `<th>`, `scope=` or `<caption>` on the
//   results grid. NO semantic landmarks. Element ids are ASP.NET-generated and look it. Layout is
//   nested tables, spacing is `&nbsp;`, text is wrapped in `<font>`. There is a real `<frameset>`,
//   and the member's sub-account list is a nested `<iframe>` INSIDE the content frame, so a driver
//   has to stitch an accessibility tree across two levels of framing to see the whole screen.
//
// A driver that reads the accessibility tree can work here. A recorder that stores
// `#ctl00_ctl32_g_9a1_txtMemberId` also "works" here - and then fails on the other tenant, whose
// prefix and field names are different. That asymmetry is the fixture's entire job.
//
// Two invisible markers are woven into every content page and are the only concession to the test
// harness. They carry no identity a locator could use; they exist so the server can cut a response
// in half:
//   SPLIT_MARKER - where `slow-load` flushes the first chunk and pauses.
//   TEAR_MARKER  - where `torn-render` truncates and ends the response mid-row.

import { PRODUCT_CODES } from "./data.js";
import { esc, fnt, nbsp } from "./html.js";
import { ctlId, ctlName } from "./tenants.js";

/** Where `slow-load` pauses: after the chrome, before any of the data the caller came for. */
export const SPLIT_MARKER = "<!-- rpt:hdr -->";

/** Where `torn-render` cuts: mid-cell, inside the results grid, so the table is left unbalanced. */
export const TEAR_MARKER = "<!-- rpt:rowbuf -->";

const SYNTHETIC_NOTICE =
  "TEST FIXTURE &mdash; SYNTHETIC DATA ONLY. Not a real financial system. " +
  "Every member, account, balance and branch below is invented.";

/**
 * The synthetic-data banner strip, repeated on every content screen rather than only in the banner
 * frame, because a driver perceives frames independently and must never see an unlabelled screen.
 * @param {import("./tenants.js").Tenant} t
 */
const syntheticStrip = (t) => `
<table width="100%" cellpadding="3" cellspacing="0" border="0" bgcolor="#FFF3CD">
<tr><td>${fnt(t, `<b>${SYNTHETIC_NOTICE}</b>`, { size: "1" })}</td></tr>
</table>`;

/**
 * A content-frame document. Summit wraps the body in one more layout table than riverbend, which is
 * the sort of markup-depth difference two implementations of one vendor product really do have.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {string} title
 * @param {string} body
 * @param {{ bodyAttrs?: string, head?: string, preamble?: string }} [opts]
 */
const doc = (t, title, body, opts = {}) => {
  const wrapped = t.extraNesting
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top">
${body}
</td></tr></table>
</td></tr></table>`
    : `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top">
${body}
</td></tr></table>`;
  return `<html>
<head><title>${esc(title)} - ${esc(t.org)}</title>${opts.head ?? ""}</head>
<body bgcolor="${t.bodyBg}" leftmargin="4" topmargin="4" marginwidth="4" marginheight="4">
${opts.preamble ?? ""}
${syntheticStrip(t)}
${SPLIT_MARKER}
${wrapped}
</body></html>`;
};

/**
 * The frameset. A real one: `<frameset>`/`<frame>`, not divs pretending.
 * @param {import("./tenants.js").Tenant} t
 */
export const framesetPage = (t) => {
  const b = t.basePath;
  return `<html>
<head><title>${esc(t.product)} ${esc(t.version)} - ${esc(t.org)}</title></head>
<frameset rows="76,*" border="1" frameborder="1" framespacing="1">
  <frame name="banner" src="${b}/banner" scrolling="no" noresize>
  <frameset cols="184,*">
    <frame name="nav" src="${b}/nav" scrolling="auto">
    <frame name="content" src="${b}/search" scrolling="auto">
  </frameset>
</frameset>
<noframes><body bgcolor="${t.bodyBg}">
${syntheticStrip(t)}
${fnt(t, "This application requires a frames-capable browser.")}
</body></noframes>
</html>`;
};

/** @param {import("./tenants.js").Tenant} t */
export const bannerFrame = (t) => `<html>
<head><title>${esc(t.org)}</title></head>
<body bgcolor="${t.bannerBg}" leftmargin="0" topmargin="0" marginwidth="0" marginheight="0">
<table width="100%" cellpadding="4" cellspacing="0" border="0">
<tr>
  <td>${fnt(t, `<b>${esc(t.org)}</b>`, { size: "4", color: t.bannerFg })}<br>
      ${fnt(t, `${esc(t.product)} ${esc(t.version)}`, { size: "1", color: t.bannerFg })}</td>
  <td align="right">${fnt(t, `Signed in as OPER-${esc(t.roleCode)} (SYNTHETIC)`, { size: "1", color: t.bannerFg })}</td>
</tr>
</table>
${syntheticStrip(t)}
</body></html>`;

/** @param {import("./tenants.js").Tenant} t */
export const navFrame = (t) => {
  const b = t.basePath;
  const item = (href, text) =>
    `<tr><td>${nbsp(1)}<a href="${href}" target="content">${fnt(t, esc(text))}</a></td></tr>`;
  return `<html>
<head><title>Menu</title></head>
<body bgcolor="#EEEEEE" leftmargin="0" topmargin="4">
<table cellpadding="3" cellspacing="0" border="0" width="100%">
<tr><td bgcolor="#DDDDDD">${fnt(t, "<b>Servicing</b>")}</td></tr>
${item(`${b}/search`, "Member Search")}
${item(`${b}/search`, "Account Maintenance")}
${item(`${b}/search`, "Card Services")}
${item(`${b}/search`, "Teller Journal")}
<tr><td>${nbsp(1)}</td></tr>
<tr><td bgcolor="#FFF3CD">${fnt(t, "<b>TEST FIXTURE &mdash; SYNTHETIC DATA ONLY</b>", { size: "1" })}</td></tr>
</table>
</body></html>`;
};

/**
 * A blocking overlay plus a modal panel. Used both for the confirmation step and for the
 * `interstitial` fault, because in the real product they are the same widget - which is exactly why
 * a replay engine must classify them by their DECLARED identity and not by "a modal is showing".
 *
 * The dim layer is a genuine full-page click interceptor: a click aimed at anything underneath hits
 * this element instead. That is SPEC section 4.5's W5 case, and it needs to be real to be caught.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {{ id: string, label: string, body: string, top?: string }} spec
 */
const modalPanel = (t, spec) => `
<div id="${spec.id}_dim" style="position:absolute;left:0;top:0;width:100%;height:100%;background:#000000;opacity:0.35;z-index:900"></div>
<div id="${spec.id}" role="dialog" aria-modal="true" aria-label="${esc(spec.label)}"
     style="position:absolute;left:96px;top:${spec.top ?? "88px"};width:420px;z-index:901;border:2px solid #444444;background:#FFFFE8;padding:10px">
<table cellpadding="3" cellspacing="0" border="0" width="100%">
<tr><td>${fnt(t, `<b>${esc(spec.label)}</b>`)}</td></tr>
<tr><td>${spec.body}</td></tr>
</table>
</div>`;

/**
 * Member search: the form and, after a postback, the results grid on the same page. Labels are
 * adjacent table cells with no `for` attribute, so the accessible name of every field has to come
 * from proximity rather than from markup that was designed to be automated.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {{ values?: {memberId?: string, lastName?: string}, results?: import("./data.js").Member[] | null, notice?: string | null, error?: string | null }} opts
 */
export const searchPage = (t, opts = {}) => {
  const v = t.vocab;
  const values = opts.values ?? {};
  const b = t.basePath;
  const errorRow = opts.error
    ? `<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#FFDDDD">
<tr><td>${fnt(t, `<b>${esc(opts.error)}</b>`, { color: "#990000" })}</td></tr>
</table><br>`
    : "";
  const noticeRow = opts.notice ? `<br>${fnt(t, `<b>${esc(opts.notice)}</b>`)}<br>` : "";
  const grid = opts.results ? resultsGrid(t, opts.results) : "";
  return doc(
    t,
    "Member Search",
    `
${errorRow}
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
${fnt(t, "<b>Member Search</b>", { size: "3" })}
</td></tr></table>
<br>
<table cellpadding="2" cellspacing="0" border="0" bgcolor="#F0F0F0">
<tr>
  <td align="right">${fnt(t, esc(v.memberId))}</td>
  <td>${nbsp(1)}<input type="text" name="${ctlName(t, "memberId")}" id="${ctlId(t, "memberId")}" size="12" maxlength="5" value="${esc(values.memberId ?? "")}"></td>
  <td>${nbsp(2)}</td>
  <td align="right">${fnt(t, esc(v.lastName))}</td>
  <td>${nbsp(1)}<input type="text" name="${ctlName(t, "lastName")}" id="${ctlId(t, "lastName")}" size="18" value="${esc(values.lastName ?? "")}"></td>
  <td>${nbsp(2)}</td>
  <td><input type="submit" name="${ctlName(t, "search")}" id="${ctlId(t, "search")}" value="${esc(v.searchButton)}"></td>
</tr>
</table>
${noticeRow}
${grid}
`,
    {
      preamble: `<form method="get" action="${b}/search/results" id="frmSearch">`,
      head: "",
    },
  ).replace("</body></html>", "</form>\n</body></html>");
};

/**
 * The results grid.
 *
 * No `<th>`, no `scope`, no `caption`, no ids on rows. Summit prepends a "Sel" radio column, so
 * COLUMN INDICES DIFFER BETWEEN TENANTS - an artifact that reads "cell 1 of the row" reads the
 * member number on riverbend and a radio button on summit. Row order is by name, so the row a
 * caller wants is generally not row one either.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member[]} rows
 */
const resultsGrid = (t, rows) => {
  const v = t.vocab;
  const b = t.basePath;
  const headers = [
    ...(t.selRadioColumn ? ["Sel"] : []),
    v.memberId,
    v.memberName,
    v.balance,
    v.status,
    v.action,
  ];
  const headerCells = headers
    .map((h) => `<td bgcolor="#CCCCCC" nowrap>${fnt(t, `<b>${esc(h)}</b>`)}</td>`)
    .join("\n  ");
  // Tear on the second row when there is one, else the first: any non-empty grid tears MID-TABLE.
  const tearAt = rows.length >= 2 ? 1 : 0;
  const bodyRows = rows
    .map((m, index) => {
      const shade = index % 2 === 1 ? ' bgcolor="#F4F4F4"' : "";
      const sel = t.selRadioColumn
        ? `<td align="center"><input type="radio" name="${ctlName(t, "grid")}$sel" value="${esc(m.memberId)}"></td>\n  `
        : "";
      // The tear point. Cutting here leaves an open <tr> and an open <td> - a torn read, not a
      // tidy short page, which is the whole difficulty of the case.
      const tear = index === tearAt ? TEAR_MARKER : "";
      return `<tr${shade}>
  ${sel}<td nowrap>${tear}${fnt(t, esc(m.memberId))}</td>
  <td nowrap>${fnt(t, esc(m.name))}</td>
  <td align="right" nowrap>${fnt(t, esc(m.balance))}</td>
  <td nowrap>${fnt(t, esc(m.status))}</td>
  <td nowrap><a href="${b}/member/${esc(m.memberId)}">${fnt(t, esc(v.openRow))}</a></td>
</tr>`;
    })
    .join("\n");
  return `
<br>
${fnt(t, `<b>${esc(v.resultsHeading)}</b>`)}${nbsp(2)}${fnt(t, `(${rows.length} record${rows.length === 1 ? "" : "s"})`, { size: "1" })}
<br>
<table id="${ctlId(t, "grid")}" cellpadding="3" cellspacing="0" border="1" bordercolor="#999999">
<tr>
  ${headerCells}
</tr>
${bodyRows}
</table>`;
};

/**
 * Member detail. The sub-account list is a NESTED IFRAME inside the content frame, so the full
 * screen only exists once a driver has stitched banner -> content -> subacct.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 */
export const memberDetailPage = (t, m) => {
  const v = t.vocab;
  const b = t.basePath;
  const row = (label, value) =>
    `<tr><td align="right" nowrap>${fnt(t, esc(label))}</td><td>${nbsp(1)}</td><td nowrap>${fnt(t, `<b>${esc(value)}</b>`)}</td></tr>`;
  return doc(
    t,
    "Member Detail",
    `
${fnt(t, "<b>Member Detail</b>", { size: "3" })}
<br><br>
<table cellpadding="0" cellspacing="0" border="0"><tr><td valign="top">
  <table cellpadding="2" cellspacing="0" border="0" bgcolor="#F0F0F0">
  ${row(v.memberId, m.memberId)}
  ${row(v.memberName, m.name)}
  ${row("Branch", m.branch)}
  ${row("Joined", m.joined)}
  ${row(v.status, m.status)}
  ${row(`Total ${v.balance}`, m.balance)}
  </table>
</td><td valign="top">${nbsp(4)}</td><td valign="top">
  <form method="get" action="${b}/member/${esc(m.memberId)}/subaccount/new">
  <input type="submit" name="${ctlName(t, "submit")}" id="${ctlId(t, "submit")}" value="${esc(v.openSubAccount)}">
  </form>
</td></tr></table>
<br>
${fnt(t, `<b>${esc(v.subAccountList)}</b>`)}
<br>
<iframe name="subacct" src="${b}/member/${esc(m.memberId)}/subaccounts" width="640" height="150" frameborder="1" scrolling="auto"></iframe>
`,
  );
};

/**
 * The nested frame: the member's existing sub-accounts.
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 */
export const subAccountsFrame = (t, m) => {
  const v = t.vocab;
  const rows =
    m.subAccounts.length === 0
      ? `<tr><td colspan="4">${fnt(t, `No ${esc(v.savingsProduct.toLowerCase())} records on file.`)}</td></tr>`
      : m.subAccounts
          .map(
            (a, i) => `<tr${i % 2 === 1 ? ' bgcolor="#F4F4F4"' : ""}>
  <td nowrap>${fnt(t, esc(a.number))}</td>
  <td nowrap>${fnt(t, `${esc(v.savingsProduct)} - ${esc(a.typeName)}`)}</td>
  <td align="right" nowrap>${fnt(t, esc(a.balance))}</td>
  <td nowrap>${fnt(t, esc(a.opened))}</td>
</tr>`,
          )
          .join("\n");
  return `<html>
<head><title>${esc(v.subAccountList)}</title></head>
<body bgcolor="#FFFFF0" leftmargin="2" topmargin="2">
${syntheticStrip(t)}
<table cellpadding="3" cellspacing="0" border="1" bordercolor="#999999">
<tr>
  <td bgcolor="#CCCCCC">${fnt(t, "<b>Acct</b>")}</td>
  <td bgcolor="#CCCCCC">${fnt(t, `<b>${esc(v.savingsProduct)}</b>`)}</td>
  <td bgcolor="#CCCCCC">${fnt(t, `<b>${esc(v.balance)}</b>`)}</td>
  <td bgcolor="#CCCCCC">${fnt(t, "<b>Opened</b>")}</td>
</tr>
${rows}
</table>
</body></html>`;
};

/**
 * The open-sub-account form.
 *
 * `dialogMode` selects the confirmation channel and is the reason this fixture has two of them:
 *   "modal"  - submit posts to /confirm, which re-renders this page under an in-page modal panel;
 *   "native" - submit is guarded by a real `window.confirm()` and posts straight to /commit.
 * SPEC section 2.2 treats a native dialog as a separate observation channel from the DOM, so the
 * fixture has to be able to put the same decision on either channel.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 * @param {{ dialogMode: "modal"|"native", values?: {type?: string, amount?: string}, error?: string | null }} opts
 */
export const newSubAccountPage = (t, m, opts) => {
  const v = t.vocab;
  const b = t.basePath;
  const values = opts.values ?? {};
  const action =
    opts.dialogMode === "native"
      ? `${b}/member/${esc(m.memberId)}/subaccount/commit`
      : `${b}/member/${esc(m.memberId)}/subaccount/confirm`;
  const guard =
    opts.dialogMode === "native"
      ? ` onclick="return window.confirm('Open a ${esc(v.savingsProduct)} for member ${esc(m.memberId)}?');"`
      : "";
  const errorRow = opts.error
    ? `<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#FFDDDD">
<tr><td>${fnt(t, `<b>${esc(opts.error)}</b>`, { color: "#990000" })}</td></tr>
</table><br>`
    : "";
  const options = PRODUCT_CODES.map(({ code, name }) => {
    const sel = values.type === code ? " selected" : "";
    return `<option value="${code}"${sel}>${esc(v.savingsProduct)} - ${esc(name)}</option>`;
  }).join("\n    ");
  return doc(
    t,
    v.openSubAccount,
    `
${errorRow}
${fnt(t, `<b>${esc(v.openSubAccount)}</b>`, { size: "3" })}
<br><br>
<table cellpadding="2" cellspacing="0" border="0" bgcolor="#F0F0F0">
<tr><td align="right" nowrap>${fnt(t, esc(v.memberId))}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(m.memberId)}</b>`)}</td></tr>
<tr><td align="right" nowrap>${fnt(t, esc(v.memberName))}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(m.name)}</b>`)}</td></tr>
<tr>
  <td align="right" nowrap>${fnt(t, esc(v.subAccountType))}</td><td>${nbsp(1)}</td>
  <td><select name="${ctlName(t, "subType")}" id="${ctlId(t, "subType")}">
    <option value="">-- select --</option>
    ${options}
  </select></td>
</tr>
<tr>
  <td align="right" nowrap>${fnt(t, esc(v.initialDeposit))}</td><td>${nbsp(1)}</td>
  <td><input type="text" name="${ctlName(t, "deposit")}" id="${ctlId(t, "deposit")}" size="12" value="${esc(values.amount ?? "")}"></td>
</tr>
<tr><td colspan="3">${nbsp(1)}</td></tr>
<tr>
  <td colspan="3"><input type="submit" name="${ctlName(t, "submit")}" id="${ctlId(t, "submit")}" value="${esc(v.submitButton)}"${guard}></td>
</tr>
</table>
`,
    { preamble: `<form method="post" action="${action}" id="frmSubAcct">` },
  ).replace("</body></html>", "</form>\n</body></html>");
};

/**
 * The in-page modal confirmation: the form, greyed out behind a click-intercepting dim layer, with
 * the decision panel on top. Confirm posts the same values on to /commit.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 * @param {{ type: string, typeName: string, amount: string }} form
 */
export const confirmModalPage = (t, m, form) => {
  const v = t.vocab;
  const b = t.basePath;
  const base = newSubAccountPage(t, m, {
    dialogMode: "modal",
    values: { type: form.type, amount: form.amount },
  });
  const panel = modalPanel(t, {
    id: `${t.ctlPrefix}_pnlConfirm`,
    label: v.confirmTitle,
    body: `
${fnt(t, `Open a ${esc(v.savingsProduct)} (${esc(form.typeName)}) for member ${esc(m.memberId)} with an opening balance of ${esc(form.amount)}?`)}
<br><br>
<form method="post" action="${b}/member/${esc(m.memberId)}/subaccount/commit" id="frmConfirm">
<input type="hidden" name="${ctlName(t, "subType")}" value="${esc(form.type)}">
<input type="hidden" name="${ctlName(t, "deposit")}" value="${esc(form.amount)}">
<input type="submit" name="${ctlName(t, "confirm")}" id="${ctlId(t, "confirm")}" value="${esc(v.confirmButton)}">
${nbsp(2)}
<input type="button" name="${ctlName(t, "cancel")}" id="${ctlId(t, "cancel")}" value="${esc(v.cancelButton)}"
 onclick="location.href='${b}/member/${esc(m.memberId)}/subaccount/new';">
</form>`,
  });
  return base.replace("</form>\n</body></html>", `</form>\n${panel}\n</body></html>`);
};

/**
 * The post-write confirmation screen.
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 * @param {import("./data.js").SubAccount} account
 * @param {string} reference
 */
export const commitPage = (t, m, account, reference) => {
  const v = t.vocab;
  const b = t.basePath;
  return doc(
    t,
    v.confirmedHeading,
    `
<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#DDF5DD">
<tr><td>${fnt(t, `<b>${esc(v.confirmedHeading)}</b>`, { color: "#005500" })}</td></tr>
</table>
<br>
<table cellpadding="2" cellspacing="0" border="0" bgcolor="#F0F0F0">
<tr><td align="right" nowrap>${fnt(t, esc(v.memberId))}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(m.memberId)}</b>`)}</td></tr>
<tr><td align="right" nowrap>${fnt(t, "Account Number")}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(m.memberId)}-${esc(account.number)}</b>`)}</td></tr>
<tr><td align="right" nowrap>${fnt(t, esc(v.subAccountType))}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(v.savingsProduct)} - ${esc(account.typeName)}</b>`)}</td></tr>
<tr><td align="right" nowrap>${fnt(t, esc(v.initialDeposit))}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(account.balance)}</b>`)}</td></tr>
<tr><td align="right" nowrap>${fnt(t, "Posting Reference")}</td><td>${nbsp(1)}</td><td>${fnt(t, `<b>${esc(reference)}</b>`)}</td></tr>
</table>
<br>
<a href="${b}/member/${esc(m.memberId)}">${fnt(t, "Return to Member Detail")}</a>
`,
  );
};

/**
 * A refusal screen. `scope` decides the wording and, downstream, decides whether this is an OUTCOME
 * or a HARD FAILURE - SPEC section 4.2 rows 7 and 8. The two screens are deliberately near-identical
 * in layout and differ only in what the sentence is ABOUT, because that is how the real product
 * renders them and it is what makes the distinction hard.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {import("./data.js").Member} m
 * @param {"record"|"role"|"closed"} scope
 */
export const deniedPage = (t, m, scope) => {
  const v = t.vocab;
  const b = t.basePath;
  const message = {
    record: `Member ${m.memberId} is restricted. A member services supervisor must service this record.`,
    role: `Your role ${t.roleCode} is not authorized for function OPEN_SUBACCOUNT. Contact your security administrator.`,
    closed: `Membership ${m.memberId} is closed. Sub-accounts cannot be opened on a closed membership.`,
  }[scope];
  const code = { record: "CB-4417", role: "CB-2203", closed: "CB-5108" }[scope];
  return doc(
    t,
    "Request Refused",
    `
<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#FFDDDD">
<tr><td>${fnt(t, "<b>Request Refused</b>", { color: "#990000" })}</td></tr>
</table>
<br>
<table cellpadding="2" cellspacing="0" border="0">
<tr><td>${fnt(t, esc(message))}</td></tr>
<tr><td>${nbsp(1)}</td></tr>
<tr><td>${fnt(t, `Reference ${esc(code)}`, { size: "1" })}</td></tr>
</table>
<br>
<a href="${b}/member/${esc(m.memberId)}">${fnt(t, `Return to ${esc(v.memberId)} ${esc(m.memberId)}`)}</a>
`,
  );
};

/**
 * The session-expired sign-in screen.
 *
 * The empty, results-shaped table is not decoration. SPEC section 4.4 names this trap explicitly: a
 * session-expiry screen whose content region looks exactly like "no results" is how a naive
 * classifier turns a timeout into MEMBER_NOT_FOUND. The fixture sets the trap on purpose.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {string} next
 */
export const signInPage = (t, next) => {
  const b = t.basePath;
  return doc(
    t,
    "Sign In",
    `
<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#FFF0D0">
<tr><td>${fnt(t, "<b>Your session has ended due to inactivity.</b>")}</td></tr>
</table>
<br>
<table cellpadding="2" cellspacing="0" border="0" bgcolor="#F0F0F0">
<tr><td align="right" nowrap>${fnt(t, "Operator ID")}</td><td>${nbsp(1)}</td>
    <td><input type="text" name="opid" id="${t.ctlPrefix}_txtOperator" size="14" value="OPER-${esc(t.roleCode)}"></td></tr>
<tr><td align="right" nowrap>${fnt(t, "Passcode")}</td><td>${nbsp(1)}</td>
    <td><input type="password" name="pass" id="${t.ctlPrefix}_txtPass" size="14" value="synthetic"></td></tr>
<tr><td colspan="3">${nbsp(1)}</td></tr>
<tr><td colspan="3"><input type="submit" name="signin" id="${t.ctlPrefix}_btnSignIn" value="Sign In"></td></tr>
</table>
<br>
${fnt(t, "<b>Results</b>", { size: "2" })}
<br>
<table cellpadding="3" cellspacing="0" border="1" bordercolor="#999999">
<tr>
  <td bgcolor="#CCCCCC">${fnt(t, `<b>${esc(t.vocab.memberId)}</b>`)}</td>
  <td bgcolor="#CCCCCC">${fnt(t, `<b>${esc(t.vocab.memberName)}</b>`)}</td>
  <td bgcolor="#CCCCCC">${fnt(t, `<b>${esc(t.vocab.balance)}</b>`)}</td>
</tr>
</table>
`,
    {
      preamble: `<form method="post" action="${b}/signin" id="frmSignIn"><input type="hidden" name="next" value="${esc(next)}">`,
    },
  ).replace("</body></html>", "</form>\n</body></html>");
};

/**
 * The vendor's unhandled-exception page. Served with HTTP 500. The stack frames are invented and
 * name nothing that exists.
 *
 * @param {import("./tenants.js").Tenant} t
 * @param {string} route
 */
export const appErrorPage = (t, route) => `<html>
<head><title>Server Error in '${esc(t.basePath || "/")}' Application.</title></head>
<body bgcolor="white">
<table width="100%" cellpadding="3" cellspacing="0" border="0" bgcolor="#FFF3CD">
<tr><td>${fnt(t, `<b>${SYNTHETIC_NOTICE}</b>`, { size: "1" })}</td></tr>
</table>
<span><h1><font face="Verdana" color="red">Server Error in '${esc(t.basePath || "/")}' Application.<hr width="100%" size="1" color="silver"></font></h1>
<h2><i>Object reference not set to an instance of an object.</i></h2></span>
<font face="Arial" size="2">
<b>Description:</b> An unhandled exception occurred during the execution of the current web request.
<br><br>
<b>Exception Details:</b> System.NullReferenceException: Object reference not set to an instance of an object.
<br><br>
<b>Source Error:</b> ${esc(route)}
<br><br>
<b>Stack Trace:</b>
<pre>[NullReferenceException: Object reference not set to an instance of an object.]
   CoreBank.Servicing.Web.MemberDetail.BindSubAccounts(Int32 mbrKey) +217
   CoreBank.Servicing.Web.MemberDetail.Page_Load(Object sender, EventArgs e) +64
   System.Web.UI.Control.OnLoad(EventArgs e) +99</pre>
</font>
</body></html>`;

/** @param {import("./tenants.js").Tenant} t */
export const notFoundPage = (t) =>
  doc(
    t,
    "Page Not Found",
    `${fnt(t, "<b>HTTP 404 - The requested resource is not available.</b>")}`,
  );

/**
 * The `interstitial` fault's widget: the SAME modal machinery the confirmation step uses.
 *
 * That is the point. In the real product an unexpected maintenance notice and an expected
 * confirmation are the same control rendered twice, so a replay engine cannot classify one by
 * "a modal is showing" - it has to match a DECLARED identity, and treat anything it cannot match as
 * `undeclared-dialog` (SPEC section 4.2 row 10). If the fixture made the interstitial visually
 * distinctive, that discipline would never be tested.
 *
 * @param {import("./tenants.js").Tenant} t
 */
export const interstitialPanel = (t) =>
  modalPanel(t, {
    id: `${t.ctlPrefix}_pnlNotice`,
    label: "System Notice",
    top: "60px",
    body: `${fnt(t, "A scheduled maintenance window for CoreBank Servicing begins at 22:00 CT. Unsaved work will be lost.")}<br><br>
<input type="button" id="${t.ctlPrefix}_btnAck" value="Acknowledge"
 onclick="document.getElementById('${t.ctlPrefix}_pnlNotice').style.display='none';document.getElementById('${t.ctlPrefix}_pnlNotice_dim').style.display='none';">`,
  });

/**
 * The `native-dialog` fault's widget: a real `window.confirm()` in a parser-blocking inline script.
 *
 * Injected immediately after `<body>` so the document is genuinely held open until something
 * answers it. A driver that has not taken ownership of the dialog channel does not see a slow page,
 * it sees a page that never finishes - which is why SPEC section 4.2 row 21 exists.
 *
 * @param {import("./tenants.js").Tenant} t
 */
export const nativeConfirmScript = (t) =>
  `<script>window.confirm("${esc(t.product)}: an interrupted batch was found for this workstation. Discard it?");</script>`;

/**
 * Splice a snippet in immediately after the `<body ...>` open tag. Returns the html unchanged if
 * there is no body tag, which is the case for the frameset document - a frameset has no body, and
 * injecting a dialog there would silently do nothing rather than obviously do nothing.
 *
 * @param {string} html
 * @param {string} snippet
 */
export const injectAfterBodyOpen = (html, snippet) => {
  const open = html.indexOf("<body");
  if (open === -1) return html;
  const close = html.indexOf(">", open);
  if (close === -1) return html;
  return `${html.slice(0, close + 1)}\n${snippet}${html.slice(close + 1)}`;
};

/**
 * Cut a rendered page short, the way a core banking box does when its session pool drops the
 * connection mid-render. Prefers the in-grid tear point; falls back to cutting off everything below
 * the page chrome when the page has no grid.
 *
 * @param {string} html
 */
export const tornSlice = (html) => {
  const at = html.includes(TEAR_MARKER) ? html.indexOf(TEAR_MARKER) : html.indexOf(SPLIT_MARKER);
  return at === -1 ? html.slice(0, Math.floor(html.length / 2)) : html.slice(0, at);
};

/**
 * Split a rendered page into the chunk that can be flushed immediately (chrome only, no data) and
 * the chunk that arrives after the injected delay.
 *
 * @param {string} html
 * @returns {[string, string]}
 */
export const splitForSlowLoad = (html) => {
  const at = html.indexOf(SPLIT_MARKER);
  if (at === -1) return ["", html];
  const cut = at + SPLIT_MARKER.length;
  return [html.slice(0, cut), html.slice(cut)];
};
