// `fixtures/corebank-web` - the hostile surface this system automates.
//
// Zero dependencies, `node:http` only. This is a fixture, not `@crr/core`, so `node:` imports, a
// mutable session map and a `setTimeout` are all fine here and are the point: the fixture owns the
// non-determinism so that the engine under test can be graded on how it copes with it.
//
// WHY THIS EXISTS AT ALL. The brief permits "an intentionally hostile surface", and a public demo
// site cannot be made to expire a session, deny an entitlement, or tear a response mid-render on
// cue - which makes most of the error taxonomy in SPEC section 4.2 undemonstrable. Every fault this
// server injects maps to a numbered row of that table, and the mapping is recorded on the fault
// itself in `faults.js` so nobody has to guess later what a scenario was supposed to prove.
//
// WHAT MAKES IT HOSTILE (see `pages.js` for the markup rules): a real `<frameset>`, a nested
// `<iframe>` inside the content frame, nested layout tables, `<font>` tags, `&nbsp;` spacing,
// ASP.NET-generated element ids that differ per tenant, and NO test ids and NO `data-*` attributes
// anywhere. A recorder that stores a CSS selector can pass on one tenant and will read the wrong
// cell on the other, because summit's results grid carries a leading radio column that shifts every
// column index by one.
//
// SESSION SCOPING. Fault state, the member store and the sign-in state all hang off a
// `CBSESSIONID` cookie, so concurrent conformance runs against one server do not interfere. Frames
// share the cookie, so arming a fault on the frameset URL arms it for the frames it spawns.
//
// ALL DATA IS SYNTHETIC. See `data.js`. Every screen carries a visible banner saying so.

import http from "node:http";

import {
  DISABLED_PRODUCT_CODE,
  PRODUCT_CODES,
  appendSubAccount,
  freshMemberStore,
  searchMembers,
} from "./data.js";
import { FAULTS, armFault, faultFiresOn } from "./faults.js";
import {
  appErrorPage,
  bannerFrame,
  commitPage,
  confirmModalPage,
  deniedPage,
  framesetPage,
  injectAfterBodyOpen,
  interstitialPanel,
  memberDetailPage,
  nativeConfirmScript,
  navFrame,
  newSubAccountPage,
  notFoundPage,
  searchPage,
  signInPage,
  splitForSlowLoad,
  subAccountsFrame,
  tornSlice,
} from "./pages.js";
import { TENANTS, TENANT_IDS, ctlName, resolveTenant } from "./tenants.js";

export { FAULTS, TENANTS, TENANT_IDS };

const SESSION_COOKIE = "CBSESSIONID";

/** Bound on the session map so a long-running fixture cannot leak; oldest-first eviction. */
const MAX_SESSIONS = 512;

/** Product code -> display name. One source of truth with the select the form renders. */
const PRODUCT_NAMES = Object.fromEntries(PRODUCT_CODES.map((p) => [p.code, p.name]));

/** Deposit amounts the app accepts. Legacy validation: digits, optional two decimals, no comma. */
const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/;

/** Member numbers are exactly five digits in this vendor product. */
const MEMBER_ID_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {number} seq                 Monotonic per-session counter; the posting reference.
 * @property {boolean} expired            Set by `session-timeout`, cleared by POST /signin.
 * @property {"modal"|"native"} dialogMode
 * @property {import("./faults.js").ArmedFault | null} armed
 * @property {Map<string, import("./data.js").Member>} members
 */

/**
 * A deterministic session id. No `Math.random`: two fixture runs that arm the same faults in the
 * same order should produce byte-identical evidence, and an id that moves between runs would show
 * up as a spurious diff in a recorded transcript.
 *
 * @param {number} n
 */
const sessionId = (n) => `s${String(n).padStart(6, "0")}`;

/** @returns {Session} */
const freshSession = (id) => ({
  id,
  seq: 0,
  expired: false,
  dialogMode: "modal",
  armed: null,
  members: freshMemberStore(),
});

/**
 * @param {string | undefined} header
 * @param {string} name
 */
const readCookie = (header, name) => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // No caching, ever. A replay engine that appears deterministic only because the browser served it
  // a stale frame is exactly the false green this project exists to make impossible.
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
};

/** @param {Ctx} ctx @param {number} status @param {string} html */
const sendHtml = (ctx, status, html) => {
  ctx.res.writeHead(status, HTML_HEADERS);
  ctx.res.end(ctx.decorate(html));
};

/** @param {Ctx} ctx @param {unknown} body */
const sendJson = (ctx, body) => {
  ctx.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(JSON.stringify(body, null, 2));
};

/**
 * Truncate the response mid-document and end it. No `content-length` is sent, so the transfer is
 * chunked and terminates cleanly at a point the markup does not: an open `<tr>` and an open `<td>`.
 * A client sees a well-formed HTTP response carrying a half-built table, which is the shape of a
 * real torn read and the reason SPEC section 4.4 puts the quiescence gate above everything else.
 *
 * @param {Ctx} ctx @param {string} html
 */
const sendTorn = (ctx, html) => {
  ctx.res.writeHead(200, HTML_HEADERS);
  ctx.res.end(tornSlice(ctx.decorate(html)));
};

/**
 * Flush the page chrome immediately, pause, then flush the data. During the pause the frame is a
 * rendered, settled-LOOKING page with no results in it - which is precisely the state a classifier
 * without a settle gate reports as MEMBER_NOT_FOUND.
 *
 * @param {Ctx} ctx @param {string} html @param {number} delayMs
 */
const sendSlow = (ctx, html, delayMs) => {
  const [head, tail] = splitForSlowLoad(ctx.decorate(html));
  ctx.res.writeHead(200, HTML_HEADERS);
  ctx.res.write(head);
  const timer = setTimeout(() => ctx.res.end(tail), delayMs);
  ctx.res.on("close", () => clearTimeout(timer));
};

// ---------------------------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Ctx
 * @property {http.IncomingMessage} req
 * @property {http.ServerResponse} res
 * @property {URL} url
 * @property {string} here            Path + query, for the sign-in screen's return target.
 * @property {import("./tenants.js").Tenant} tenant
 * @property {string} route           Tenant-relative path.
 * @property {Session} session
 * @property {URLSearchParams} form   Parsed request body for POSTs; empty otherwise.
 * @property {(html: string) => string} decorate
 */

/**
 * Read a form field by its tenant-specific ASP.NET name, falling back to a plain alias so the
 * fixture stays drivable from `curl` and from a test without reconstructing `ctl00$ctl32$...`.
 *
 * @param {Ctx} ctx @param {URLSearchParams} params @param {"memberId"|"lastName"|"subType"|"deposit"} field
 */
const field = (ctx, params, field_) =>
  params.get(ctlName(ctx.tenant, field_)) ?? params.get(field_) ?? "";

/** @param {http.IncomingMessage} req */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("fixture: request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// ---------------------------------------------------------------------------------------------
// Content screens and fault dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Serve one content screen, applying whatever fault is armed for this session and scoped to this
 * screen. `produce` receives the id of the fault that fired, or null, so route handlers can render
 * the CONTENT-level faults (a not-found grid, a validation banner, a refusal screen) while the
 * TRANSPORT-level faults (500, torn, slow, expiry) and the two dialog faults are handled once here.
 *
 * Order is deliberate and mirrors the interpreter's own precedence: an expired session beats
 * everything, because a screen served to a logged-out session says nothing about the business
 * question that was asked.
 *
 * @param {Ctx} ctx
 * @param {string} screen
 * @param {(firedFault: string | null) => { html: string, status?: number }} produce
 */
const serveContent = (ctx, screen, produce) => {
  if (ctx.session.expired) return sendHtml(ctx, 200, signInPage(ctx.tenant, ctx.here));

  const armed = faultFiresOn(ctx.session.armed, screen) ? ctx.session.armed : null;
  const consume = () => {
    if (armed && armed.mode === "once") ctx.session.armed = null;
  };

  if (armed?.id === "app-error") {
    consume();
    return sendHtml(ctx, 500, appErrorPage(ctx.tenant, ctx.route));
  }
  if (armed?.id === "session-timeout") {
    ctx.session.expired = true;
    consume();
    return sendHtml(ctx, 200, signInPage(ctx.tenant, ctx.here));
  }

  const produced = produce(armed?.id ?? null);
  let html = produced.html;
  if (armed?.id === "interstitial") html = injectAfterBodyOpen(html, interstitialPanel(ctx.tenant));
  if (armed?.id === "native-dialog") {
    html = injectAfterBodyOpen(html, nativeConfirmScript(ctx.tenant));
  }
  consume();

  if (armed?.id === "torn-render") return sendTorn(ctx, html);
  if (armed?.id === "slow-load") return sendSlow(ctx, html, armed.delayMs);
  return sendHtml(ctx, produced.status ?? 200, html);
};

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const MEMBER_ROUTE = /^\/member\/([^/]+)(\/subaccounts|\/subaccount\/(new|confirm|commit))?$/;

/** @param {Ctx} ctx */
const routeFixtureControl = (ctx) => {
  const { url, session } = ctx;
  if (ctx.route === "/__fixture/faults") {
    return sendJson(ctx, {
      faults: Object.values(FAULTS),
      tenants: TENANT_IDS.map((id) => ({ id, basePath: TENANTS[id].basePath })),
    });
  }
  if (ctx.route === "/__fixture/state") {
    return sendJson(ctx, {
      session: session.id,
      expired: session.expired,
      dialogMode: session.dialogMode,
      armed: session.armed,
      members: [...session.members.values()].map((m) => ({
        memberId: m.memberId,
        subAccounts: m.subAccounts.length,
      })),
    });
  }
  if (ctx.route === "/__fixture/reset") {
    // The reset hook SPEC section 6.6 calls for: it is what lets verification replay run in
    // `replay-reset` mode and be graded `full` instead of `partial-up-to-irreversible`. Real core
    // banking has no such hook, which is exactly why the spec treats the mode as fixture-only.
    const fresh = freshSession(session.id);
    session.seq = 0;
    session.expired = false;
    session.dialogMode = "modal";
    session.armed = null;
    session.members = fresh.members;
    return sendJson(ctx, { ok: true, session: session.id, reset: true });
  }
  if (ctx.route === "/__fixture/fault") {
    if (url.searchParams.has("clear")) {
      session.armed = null;
      return sendJson(ctx, { ok: true, session: session.id, armed: null });
    }
    const armed = armFault(url.searchParams.get("set"), {
      at: url.searchParams.get("at"),
      mode: url.searchParams.get("mode"),
      delayMs: url.searchParams.get("delayMs"),
    });
    session.armed = armed;
    return sendJson(ctx, { ok: armed !== null, session: session.id, armed });
  }
  return sendJson(ctx, { ok: false, error: "unknown fixture control route", route: ctx.route });
};

/** @param {Ctx} ctx */
const routeSearch = (ctx) =>
  serveContent(ctx, "search", () => ({ html: searchPage(ctx.tenant, {}) }));

/** @param {Ctx} ctx */
const routeResults = (ctx) => {
  const q = ctx.url.searchParams;
  const values = { memberId: field(ctx, q, "memberId"), lastName: field(ctx, q, "lastName") };
  return serveContent(ctx, "results", (fired) => {
    // Organic validation on a value the CALLER supplied: SPEC section 4.2 row 4, an outcome. The
    // identical banner is a hard failure when the rejected value came from the artifact - see the
    // `validation-error` fault on the confirm screen, which is row 5.
    if (values.memberId !== "" && !MEMBER_ID_RE.test(values.memberId)) {
      return {
        html: searchPage(ctx.tenant, {
          values,
          error: `${ctx.tenant.vocab.memberId} must be exactly 5 digits.`,
        }),
      };
    }
    const rows = fired === "not-found" ? [] : searchMembers(ctx.session.members, values);
    return {
      html: searchPage(ctx.tenant, {
        values,
        results: rows,
        notice: rows.length === 0 ? "No members matched the search criteria." : null,
      }),
    };
  });
};

/** @param {Ctx} ctx @param {string} memberId */
const routeMemberDetail = (ctx, memberId) => {
  const member = ctx.session.members.get(memberId);
  return serveContent(ctx, "detail", () =>
    member
      ? { html: memberDetailPage(ctx.tenant, member) }
      : {
          html: searchPage(ctx.tenant, {
            error: `${ctx.tenant.vocab.memberId} ${memberId} is not on file.`,
          }),
        },
  );
};

/** @param {Ctx} ctx @param {string} memberId */
const routeSubAccounts = (ctx, memberId) => {
  const member = ctx.session.members.get(memberId);
  return serveContent(ctx, "subaccounts", () =>
    member
      ? { html: subAccountsFrame(ctx.tenant, member) }
      : { html: notFoundPage(ctx.tenant), status: 404 },
  );
};

/** @param {Ctx} ctx @param {string} memberId */
const routeNewSubAccount = (ctx, memberId) => {
  const member = ctx.session.members.get(memberId);
  return serveContent(ctx, "new", () =>
    member
      ? {
          html: newSubAccountPage(ctx.tenant, member, { dialogMode: ctx.session.dialogMode }),
        }
      : { html: notFoundPage(ctx.tenant), status: 404 },
  );
};

/**
 * Validate the open-sub-account form the way the legacy app does: one banner, first problem wins.
 * @param {Ctx} ctx @param {{ type: string, amount: string }} form @param {string | null} fired
 * @returns {string | null}
 */
const validateSubAccountForm = (ctx, form, fired) => {
  const v = ctx.tenant.vocab;
  if (fired === "validation-error") {
    return `Product code ${form.type || "(none)"} is not enabled for this branch.`;
  }
  if (form.type === "") return `${v.subAccountType} is required.`;
  // Organic instance of the same row-5 shape, with no fault armed: an artifact that recorded the
  // Holiday Club product code is simply wrong at this branch, forever, for every caller.
  if (form.type === DISABLED_PRODUCT_CODE) {
    return `Product code ${DISABLED_PRODUCT_CODE} is not enabled for this branch.`;
  }
  if (!AMOUNT_RE.test(form.amount)) return `${v.initialDeposit} must be a numeric amount.`;
  return null;
};

/** @param {Ctx} ctx @param {string} memberId */
const routeConfirm = (ctx, memberId) => {
  const member = ctx.session.members.get(memberId);
  const form = { type: field(ctx, ctx.form, "subType"), amount: field(ctx, ctx.form, "deposit") };
  return serveContent(ctx, "confirm", (fired) => {
    if (!member) return { html: notFoundPage(ctx.tenant), status: 404 };
    const error = validateSubAccountForm(ctx, form, fired);
    if (error) {
      return {
        html: newSubAccountPage(ctx.tenant, member, {
          dialogMode: ctx.session.dialogMode,
          values: { type: form.type, amount: form.amount },
          error,
        }),
      };
    }
    return {
      html: confirmModalPage(ctx.tenant, member, {
        type: form.type,
        typeName: PRODUCT_NAMES[form.type] ?? form.type,
        amount: form.amount,
      }),
    };
  });
};

/** @param {Ctx} ctx @param {string} memberId */
const routeCommit = (ctx, memberId) => {
  const member = ctx.session.members.get(memberId);
  const form = { type: field(ctx, ctx.form, "subType"), amount: field(ctx, ctx.form, "deposit") };
  return serveContent(ctx, "commit", (fired) => {
    if (!member) return { html: notFoundPage(ctx.tenant), status: 404 };

    const error = validateSubAccountForm(ctx, form, fired);
    if (error) {
      return {
        html: newSubAccountPage(ctx.tenant, member, {
          dialogMode: ctx.session.dialogMode,
          values: { type: form.type, amount: form.amount },
          error,
        }),
      };
    }
    // Two refusals that render almost identically and mean opposite things. Which one this is has
    // to be DECLARED by the artifact author; a classifier that guesses gets rows 7 and 8 backwards.
    if (fired === "permission-denied-role") return { html: deniedPage(ctx.tenant, member, "role") };
    if (fired === "permission-denied-record" || member.status === "RESTRICTED") {
      return { html: deniedPage(ctx.tenant, member, "record") };
    }
    if (member.status === "CLOSED") return { html: deniedPage(ctx.tenant, member, "closed") };

    // The write. Not idempotent on purpose - see `appendSubAccount`.
    const account = appendSubAccount(member, {
      type: form.type,
      typeName: PRODUCT_NAMES[form.type] ?? form.type,
      amount: form.amount,
    });
    ctx.session.seq += 1;
    const reference = `TXN-${String(ctx.session.seq).padStart(6, "0")}`;
    return { html: commitPage(ctx.tenant, member, account, reference) };
  });
};

/** @param {Ctx} ctx */
const routeSignIn = (ctx) => {
  if (ctx.req.method !== "POST") {
    return sendHtml(ctx, 200, signInPage(ctx.tenant, ctx.here));
  }
  ctx.session.expired = false;
  const requested = ctx.form.get("next") ?? "";
  // Only same-origin absolute paths, so the fixture cannot be turned into an open redirect even in
  // a throwaway test harness.
  const next =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : `${ctx.tenant.basePath}/search`;
  ctx.res.writeHead(302, { location: next, "cache-control": "no-store" });
  ctx.res.end();
};

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

/**
 * Create the fixture server. Nothing is listening until `.listen()` is called, so a test can bind
 * an ephemeral port and several servers can coexist in one process.
 *
 * @returns {http.Server}
 */
export const createFixtureServer = () => {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  let sessionCounter = 0;

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const resolveSession = (req, res, url) => {
    const requested =
      /** @type {string | undefined} */ (req.headers["x-corebank-session"]) ??
      url.searchParams.get("_sid") ??
      readCookie(/** @type {string | undefined} */ (req.headers.cookie), SESSION_COOKIE) ??
      null;
    let session = requested ? sessions.get(requested) : undefined;
    if (!session) {
      sessionCounter += 1;
      const id = requested ?? sessionId(sessionCounter);
      session = freshSession(id);
      sessions.set(id, session);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${session.id}; Path=/; SameSite=Lax`);
    // Echoed on every response so a driver, a log or a failing test can say which session a page
    // came from without parsing cookies.
    res.setHeader("x-corebank-session", session.id);
    return session;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const session = resolveSession(req, res, url);

    // Arming is read off every request, so `?_fault=` on the frameset URL arms the frames it
    // spawns, and a header works for a driver that would rather not touch the URL.
    const rawFault =
      url.searchParams.get("_fault") ??
      /** @type {string | undefined} */ (req.headers["x-corebank-fault"]) ??
      null;
    if (rawFault !== null) {
      session.armed = armFault(rawFault, {
        at: url.searchParams.get("_faultAt") ?? req.headers["x-corebank-fault-at"] ?? null,
        mode: url.searchParams.get("_faultMode") ?? req.headers["x-corebank-fault-mode"] ?? null,
        delayMs:
          url.searchParams.get("_faultDelayMs") ?? req.headers["x-corebank-fault-delay"] ?? null,
      });
    }
    const rawDialog = url.searchParams.get("dialog") ?? req.headers["x-corebank-dialog"] ?? null;
    if (rawDialog === "native" || rawDialog === "modal") session.dialogMode = rawDialog;

    const { tenant, rest } = resolveTenant(url.pathname);
    // Control routes live under every tenant's base path as well as the bare root, so a driver
    // already pinned to `/cb` never has to leave the tenant it is testing to arm a fault.
    const isControl = rest.startsWith("/__fixture/");
    const route = rest;

    /** @type {Ctx} */
    const ctx = {
      req,
      res,
      url,
      here: `${url.pathname}${url.search}`,
      tenant,
      route,
      session,
      form: new URLSearchParams(),
      // Every served document carries the tenant and session in an HTML comment. It is invisible to
      // a locator, it is the first thing anyone wants when a scenario fails, and putting it in the
      // markup rather than only in a header means a saved page is self-describing.
      decorate: (html) =>
        `<!-- corebank-web fixture | tenant=${tenant.id} | session=${session.id} | synthetic data only -->\n${html}`,
    };

    try {
      if (req.method === "POST") ctx.form = new URLSearchParams(await readBody(req));

      if (isControl) return routeFixtureControl(ctx);
      if (route === "/" || route === "") return sendHtml(ctx, 200, framesetPage(tenant));
      if (route === "/banner") return sendHtml(ctx, 200, bannerFrame(tenant));
      if (route === "/nav") return sendHtml(ctx, 200, navFrame(tenant));
      if (route === "/search") return routeSearch(ctx);
      if (route === "/search/results") return routeResults(ctx);
      if (route === "/signin") return routeSignIn(ctx);

      const member = MEMBER_ROUTE.exec(route);
      if (member) {
        const memberId = decodeURIComponent(member[1]);
        const tail = member[2] ?? "";
        if (tail === "") return routeMemberDetail(ctx, memberId);
        if (tail === "/subaccounts") return routeSubAccounts(ctx, memberId);
        if (tail === "/subaccount/new") return routeNewSubAccount(ctx, memberId);
        if (tail === "/subaccount/confirm") return routeConfirm(ctx, memberId);
        if (tail === "/subaccount/commit") return routeCommit(ctx, memberId);
      }
      return sendHtml(ctx, 404, notFoundPage(tenant));
    } catch (cause) {
      // A fixture bug must not look like an injected fault. `app-error` is a 500 with the vendor's
      // exception page; a genuine crash in here is a plain-text 500 that says which it is.
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`fixture internal error (NOT an injected fault): ${String(cause)}`);
    }
  });
};

/**
 * Boot the fixture and resolve once it is accepting connections.
 *
 * @param {{ port?: number, host?: string }} [opts] Port 0 binds an ephemeral port.
 * @returns {Promise<{ server: http.Server, port: number, origin: string, close: () => Promise<void> }>}
 */
export const startFixtureServer = async (opts = {}) => {
  const server = createFixtureServer();
  const host = opts.host ?? "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture: server did not bind a TCP port");
  }
  return {
    server,
    port: address.port,
    origin: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined))),
      ),
  };
};

// `node src/server.js [port]`, or `pnpm -F @crr/fixture-corebank-web start -- 9000`, which forwards
// a literal `--` in argv - hence taking the first argument that is actually a number rather than
// the first argument at all.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argPort = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  const port = Number.parseInt(argPort ?? process.env.PORT ?? "8731", 10);
  startFixtureServer({ port }).then(({ origin }) => {
    process.stdout.write(
      [
        `corebank-web fixture listening on ${origin}`,
        `  riverbend  ${origin}/`,
        `  summit     ${origin}/cb/`,
        `  faults     ${origin}/__fixture/faults`,
        "  ALL DATA IS SYNTHETIC. This is a test fixture, not a financial system.",
        "",
      ].join("\n"),
    );
  });
}
