// Two tenants of ONE vendor product.
//
// This file is the whole multi-tenant argument in miniature. `riverbend` and `summit` run the same
// CoreBank Servicing build, configured by the vendor's implementation team at go-live. Everything
// that differs here is something a real credit-union deployment actually differs on:
//
//   - branding and product point-version;
//   - the FIELD LABEL vocabulary ("Member ID" vs "Member Number", "Share Account" vs "Savings
//     Account") - the single most common per-tenant difference, and the reason SPEC section 9.3
//     makes the vocabulary token the hinge of the overlay design;
//   - the mount path (`` vs `/cb`), which is what `overlay.routeBasePath` exists for;
//   - markup detail: generated control-id prefixes, an extra layout-table nesting level, and a
//     leading "Sel" radio column on the results grid that SHIFTS EVERY COLUMN INDEX BY ONE.
//
// That last one is deliberate and load-bearing. An artifact that finds the member row by column
// index passes on riverbend and silently reads the wrong cell on summit. An artifact that finds it
// by the Member ID header cell passes on both. The fixture is built so the weaker design is the one
// that breaks.
//
// What is deliberately IDENTICAL across both tenants: frame names, the row-action link text
// ("Open"), the roles of every control, and the step sequence. SPEC section 9.4 makes the point
// that some per-tenant differences need no overlay at all; a fixture where EVERYTHING differs would
// hide that.

/**
 * @typedef {object} TenantVocabulary
 * @property {string} memberId          Label on the member identifier field and results column.
 * @property {string} lastName          Label on the surname search field.
 * @property {string} memberName        Results-grid column header for the member's name.
 * @property {string} balance           Results-grid column header for the savings balance.
 * @property {string} status            Results-grid column header for the account status.
 * @property {string} action            Results-grid column header for the row action.
 * @property {string} openRow           Text of the per-row link into member detail.
 * @property {string} searchButton      Submit control on the member search form.
 * @property {string} resultsHeading    Heading above the results grid.
 * @property {string} savingsProduct    The savings product's name in this tenant's dialect.
 * @property {string} subAccountList    Heading over the existing sub-account list.
 * @property {string} openSubAccount    The control that starts the open-sub-account flow.
 * @property {string} subAccountType    Label on the sub-account product select.
 * @property {string} initialDeposit    Label on the opening deposit field.
 * @property {string} submitButton      Submit control on the open-sub-account form.
 * @property {string} confirmTitle      Accessible name of the confirmation modal.
 * @property {string} confirmButton     Affirmative control in the confirmation modal.
 * @property {string} cancelButton      Negative control in the confirmation modal.
 * @property {string} confirmedHeading  Heading on the post-write confirmation screen.
 */

/**
 * @typedef {object} TenantFieldNames
 * @property {string} memberId
 * @property {string} lastName
 * @property {string} search
 * @property {string} grid
 * @property {string} subType
 * @property {string} deposit
 * @property {string} submit
 * @property {string} confirm
 * @property {string} cancel
 */

/**
 * @typedef {object} Tenant
 * @property {string} id
 * @property {string} basePath          "" for riverbend, "/cb" for summit. Never a trailing slash.
 * @property {string} org
 * @property {string} product
 * @property {string} version
 * @property {string} fontFace
 * @property {string} bodyBg
 * @property {string} bannerBg
 * @property {string} bannerFg
 * @property {string} ctlPrefix         ASP.NET-style generated control-id prefix.
 * @property {TenantFieldNames} names
 * @property {TenantVocabulary} vocab
 * @property {boolean} selRadioColumn   Summit prepends a radio column, shifting every column index.
 * @property {boolean} extraNesting     Summit wraps content in one more layout table than riverbend.
 * @property {string} roleCode          The synthetic user role, quoted in the role-scoped denial.
 */

/** @type {Tenant} */
const riverbend = {
  id: "riverbend",
  basePath: "",
  org: "Riverbend Federal Credit Union",
  product: "CoreBank Servicing",
  version: "8.2.14",
  fontFace: "Arial",
  bodyBg: "#FFFFFF",
  bannerBg: "#1F3D66",
  bannerFg: "#FFFFFF",
  ctlPrefix: "ctl00_ctl32_g_9a1",
  names: {
    memberId: "txtMemberId",
    lastName: "txtLast",
    search: "btnGo",
    grid: "grdResults",
    subType: "ddlSubType",
    deposit: "txtAmt",
    submit: "btnOpenSub",
    confirm: "btnConfirm",
    cancel: "btnCancel",
  },
  vocab: {
    memberId: "Member ID",
    lastName: "Last Name",
    memberName: "Name",
    balance: "Share Balance",
    status: "Status",
    action: "Action",
    openRow: "Open",
    searchButton: "Search",
    resultsHeading: "Search Results",
    savingsProduct: "Share Account",
    subAccountList: "Share Accounts",
    openSubAccount: "Open Sub-Account",
    subAccountType: "Sub-Account Type",
    initialDeposit: "Initial Deposit",
    submitButton: "Open Account",
    confirmTitle: "Confirm Sub-Account",
    confirmButton: "Confirm",
    cancelButton: "Cancel",
    confirmedHeading: "Sub-Account Opened",
  },
  selRadioColumn: false,
  extraNesting: false,
  roleCode: "TELLER1",
};

/** @type {Tenant} */
const summit = {
  id: "summit",
  basePath: "/cb",
  org: "Summit Community Bank",
  product: "CoreBank Servicing",
  version: "8.4.02",
  fontFace: "Verdana",
  bodyBg: "#F7F7F0",
  bannerBg: "#4A5D23",
  bannerFg: "#FFFFF0",
  ctlPrefix: "ctl00_ctl41_g_c7e2",
  names: {
    memberId: "txtMbrNo",
    lastName: "txtSurname",
    search: "btnFind",
    grid: "gvMembers",
    subType: "ddlAcctType",
    deposit: "txtOpenAmt",
    submit: "btnAddSub",
    confirm: "btnYes",
    cancel: "btnNo",
  },
  vocab: {
    memberId: "Member Number",
    lastName: "Surname",
    memberName: "Member Name",
    balance: "Savings Balance",
    status: "Acct Status",
    action: "Select",
    // Identical to riverbend ON PURPOSE: SPEC section 9.4's point that not every per-tenant
    // difference needs an overlay. An artifact step that says `activate the link named Open`
    // replays unmodified on both tenants.
    openRow: "Open",
    searchButton: "Find",
    resultsHeading: "Member Search Results",
    savingsProduct: "Savings Account",
    subAccountList: "Savings Accounts",
    openSubAccount: "Add Sub-Account",
    subAccountType: "Account Type",
    initialDeposit: "Opening Deposit",
    submitButton: "Add Account",
    confirmTitle: "Confirm New Account",
    confirmButton: "Yes",
    cancelButton: "No",
    confirmedHeading: "Sub-Account Added",
  },
  selRadioColumn: true,
  extraNesting: true,
  roleCode: "CSR2",
};

/** @type {Readonly<Record<string, Tenant>>} */
export const TENANTS = Object.freeze({ riverbend, summit });

/** Tenant ids in a stable order, so tests and docs enumerate them the same way. */
export const TENANT_IDS = Object.freeze(["riverbend", "summit"]);

/**
 * Resolve the tenant from a request path by longest matching base path.
 *
 * Ordering matters: "/cb" must be tested before "" or every summit request resolves to riverbend.
 *
 * @param {string} pathname
 * @returns {{ tenant: Tenant, rest: string }}
 */
export const resolveTenant = (pathname) => {
  const byLongestBase = Object.values(TENANTS).sort(
    (a, b) => b.basePath.length - a.basePath.length,
  );
  for (const tenant of byLongestBase) {
    if (tenant.basePath === "") continue;
    if (pathname === tenant.basePath || pathname.startsWith(`${tenant.basePath}/`)) {
      return { tenant, rest: pathname.slice(tenant.basePath.length) || "/" };
    }
  }
  return { tenant: riverbend, rest: pathname };
};

/**
 * The generated element id for a logical field, e.g. `ctl00_ctl32_g_9a1_txtMemberId`.
 * Deliberately unstable-looking and different per tenant: nothing above the driver may depend on it.
 *
 * @param {Tenant} tenant
 * @param {keyof TenantFieldNames} field
 */
export const ctlId = (tenant, field) => `${tenant.ctlPrefix}_${tenant.names[field]}`;

/**
 * The ASP.NET `$`-separated form field name for the same logical field.
 *
 * @param {Tenant} tenant
 * @param {keyof TenantFieldNames} field
 */
export const ctlName = (tenant, field) =>
  `${tenant.ctlPrefix.replaceAll("_", "$")}$${tenant.names[field]}`;
