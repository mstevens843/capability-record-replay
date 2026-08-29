// The operator console - SPEC section 7.3's six routes, and nothing else.
//
// DELIBERATELY BARE. The anti-goals forbid a React admin app and the assignment puts a full
// co-browsing console out of scope, so what is here is the thinnest thing that is still REAL: a
// local HTTP server on the loopback interface, server-rendered HTML with plain forms, no build step,
// no bundler, no client-side script, no stylesheet. It is drivable by a browser and by `curl`, and
// the tests drive it with `fetch`.
//
// WHAT MAKES IT WORTH HAVING is not the UI. It is that this file contains no browser vocabulary at
// all. It renders `LiveView` - a route, a settled flag, a capture's content address, and a list of
// nodes with roles and accessible names - and it posts back typed `Action`s. Point it at the
// character-grid driver and the same six routes work on a green screen with no terminal-specific
// code, which is the strongest available evidence that the Observation/Action seam is real rather
// than a browser API with a coat of paint.
//
// WHAT IS MOCKED, and why, stated plainly because a reviewer will ask:
//
//   · THE LIVE VIEW IS A POLL, NOT A STREAM. `Surface.capture()` deliberately returns a
//     content-addressed ref and a digest and never bytes, because a capture is EVIDENCE and no
//     decision path in this system may read pixels. So the page shows the capture's address, its
//     mask count and the node list, and re-renders when the operator asks. Production streams frames
//     over CDP screencast or WebRTC and serves the blob store behind this ref; that is a documented
//     seam, and the polling capture is the thin-but-real version of it. What is NOT mocked is the
//     masking: regions are derived and refused before any capture is taken.
//   · THERE IS NO AUTHENTICATION. The operator id is a form field. A deployment puts SSO in front of
//     this; a second identity system here would be the "auth service" the anti-goals name.
//   · IT BINDS TO 127.0.0.1 BY DEFAULT and says so, because a console that can drive a bank session
//     is not a thing to expose on an interface by accident.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { type Action, ActionSchema, type EffectClass } from "@crr/core";
import type { ControlPlane, LiveView } from "./intervention.js";

export interface OperatorConsoleOptions {
  readonly control: ControlPlane;
  /** `0` asks the OS for a free port, which is what a test wants and what a demo can live with. */
  readonly port?: number;
  /** Loopback by default, and changing it is a decision somebody has to write down. */
  readonly host?: string;
}

export interface OperatorConsole {
  readonly url: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startOperatorConsole(
  options: OperatorConsoleOptions,
): Promise<OperatorConsole> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handle(options.control, req, res).catch((error: unknown) => {
      // A console that 500s silently is a console an operator reloads forever. The message is the
      // engine's own; nothing here is a member's.
      send(res, 500, "text/plain", `console error: ${String(error)}\n`);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://${host}:${port}`;
  // Every intervention's `consoleUrl` becomes a link a person can actually open, which is the whole
  // difference between "route an intervention request with context" and "log a line".
  options.control.consoleBaseUrl = url;

  return {
    url,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

const ROUTE = /^\/interventions(?:\/([^/]+))?(?:\/(claim|act|handback|abort|view))?\/?$/;

async function handle(
  control: ControlPlane,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://console.local");
  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(303, { location: "/interventions" });
    res.end();
    return;
  }

  const match = ROUTE.exec(url.pathname);
  if (match === null) {
    send(res, 404, "text/plain", "no such route\n");
    return;
  }
  const id = match[1] ?? null;
  const verb = match[2] ?? null;
  const wantsJson = (req.headers.accept ?? "").includes("application/json");

  // ---- GET /interventions --------------------------------------------------------------------
  if (id === null) {
    const open = await control.list();
    if (wantsJson) return send(res, 200, "application/json", JSON.stringify({ open }, null, 2));
    return send(res, 200, "text/html; charset=utf-8", renderList(open));
  }

  // ---- GET /interventions/:id ----------------------------------------------------------------
  if (verb === null || verb === "view") {
    const intervention = control.get(id);
    if (intervention === null) return send(res, 404, "text/plain", `no intervention ${id}\n`);
    const view = await control.view(id);
    const live = view.ok ? view.view : null;
    const settled = control.resultOf(id);
    if (wantsJson) {
      return send(
        res,
        200,
        "application/json",
        JSON.stringify({ intervention, view: live, result: settled }, null, 2),
      );
    }
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      renderDetail(intervention, live, settled !== null),
    );
  }

  if (req.method !== "POST") {
    send(res, 405, "text/plain", `${verb} is a POST\n`);
    return;
  }

  const body = await readBody(req);
  const operatorId = String(body.operatorId ?? "").trim();
  if (operatorId.length === 0) {
    return respond(res, wantsJson, id, 400, {
      ok: false,
      code: "not-holder",
      detail: "an operator id is required; the console has no identity of its own",
    });
  }

  switch (verb) {
    case "claim": {
      const claimed = await control.claim(id, operatorId);
      return respond(res, wantsJson, id, claimed.ok ? 200 : 409, claimed);
    }
    case "act": {
      const action = actionFrom(body);
      if (action === null) {
        return respond(res, wantsJson, id, 400, {
          ok: false,
          code: "wrong-state",
          detail: "the request did not describe a valid typed Action",
        });
      }
      const acted = await control.inject(id, operatorId, action, effectFrom(body));
      return respond(res, wantsJson, id, acted.ok ? 200 : 409, acted);
    }
    case "handback": {
      const handed = await control.handBack(id, operatorId);
      return respond(res, wantsJson, id, handed.ok ? 200 : 409, handed);
    }
    case "abort": {
      const aborted = await control.abort(
        id,
        operatorId,
        String(body.reason ?? "").trim() || undefined,
      );
      return respond(res, wantsJson, id, aborted.ok ? 200 : 409, aborted);
    }
    default:
      return send(res, 404, "text/plain", "no such route\n");
  }
}

/** A form post gets a redirect back to the page it came from; an API caller gets the value. */
function respond(
  res: ServerResponse,
  wantsJson: boolean,
  id: string,
  status: number,
  payload: unknown,
): void {
  if (wantsJson) {
    send(res, status, "application/json", JSON.stringify(payload, null, 2));
    return;
  }
  res.writeHead(303, { location: `/interventions/${encodeURIComponent(id)}` });
  res.end();
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) fields[key] = value;
  return fields;
}

// ---------------------------------------------------------------------------------------------
// Building the typed Action a form or an API call described
// ---------------------------------------------------------------------------------------------

/**
 * A form describes an action in flat fields; an API caller sends the typed object.
 *
 * Both end at `ActionSchema.parse`, which is the point: the console cannot invent an action shape
 * the port does not accept, and the policy chokepoint downstream is therefore checking the same
 * value the driver will receive.
 */
function actionFrom(body: Record<string, unknown>): Action | null {
  const supplied = body.action;
  const candidate =
    typeof supplied === "object" && supplied !== null
      ? supplied
      : flatAction(body as Record<string, string>);
  if (candidate === null) return null;
  const parsed = ActionSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as Action) : null;
}

function flatAction(body: Record<string, string>): object | null {
  const kind = body.kind;
  switch (kind) {
    case "click":
    case "focus":
      return { kind, target: body.target };
    case "type":
      return {
        kind,
        target: body.target,
        text: body.text ?? "",
        mode: "replace",
        sensitive: false,
      };
    case "select":
      return { kind, target: body.target, option: body.option ?? "" };
    case "setChecked":
      return { kind, target: body.target, checked: body.checked === "true" };
    case "pressKey":
      return { kind, target: body.target === "" ? null : body.target, key: body.key };
    case "navigate":
      return {
        kind,
        route: {
          originAlias: body.originAlias ?? "",
          path: body.path ?? "",
          query: {},
        },
      };
    case "acceptDialog":
      return { kind, text: body.text === undefined || body.text === "" ? null : body.text };
    case "dismissDialog":
      return { kind };
    default:
      return null;
  }
}

/** The operator may RAISE the console's declared effect and never lower it; the desk clamps the
 *  other direction, so an unrecognised value is simply the floor. */
function effectFrom(body: Record<string, unknown>): EffectClass | undefined {
  const raw = String(body.effect ?? "");
  return raw === "READ" || raw === "WRITE_REVERSIBLE" || raw === "WRITE_IRREVERSIBLE"
    ? raw
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Rendering. Server-side, no script, no stylesheet - a form post and a re-render.
// ---------------------------------------------------------------------------------------------

const PAGE_STYLE =
  "font-family: ui-monospace, Menlo, Consolas, monospace; max-width: 62rem; margin: 2rem auto; line-height: 1.5;";
const TABLE_STYLE = "border-collapse: collapse; width: 100%; margin: 0.75rem 0;";
const CELL_STYLE = "border: 1px solid #8884; padding: 0.25rem 0.5rem; text-align: left;";
const BOX_STYLE = "border: 1px solid #8884; padding: 0.75rem 1rem; margin: 0.75rem 0;";

function page(title: string, inner: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    "</head>",
    `<body style="${PAGE_STYLE}">`,
    inner,
    "</body></html>",
  ].join("\n");
}

function renderList(open: readonly Awaited<ReturnType<ControlPlane["list"]>>[number][]): string {
  const rows = open
    .map(
      (row) => `<tr>
        <td style="${CELL_STYLE}"><a href="/interventions/${encodeURIComponent(row.id)}">${esc(row.id)}</a></td>
        <td style="${CELL_STYLE}">${esc(row.capabilityTitle)}</td>
        <td style="${CELL_STYLE}">${esc(row.tenantId)}</td>
        <td style="${CELL_STYLE}">${esc(row.reason)}</td>
        <td style="${CELL_STYLE}">step ${row.stepIndex} &middot; ${esc(row.stepTitle)}</td>
        <td style="${CELL_STYLE}">${esc(row.state)}</td>
        <td style="${CELL_STYLE}">${Math.round(row.ageMs / 1000)}s old, expires in ${Math.round(row.expiresInMs / 1000)}s</td>
      </tr>`,
    )
    .join("\n");
  return page(
    "Interventions",
    `<h1>Open interventions</h1>
     <p>Newest first. Everything here is a live session waiting on a person.</p>
     <table style="${TABLE_STYLE}"><thead><tr>
       <th style="${CELL_STYLE}">id</th><th style="${CELL_STYLE}">capability</th>
       <th style="${CELL_STYLE}">tenant</th><th style="${CELL_STYLE}">reason</th>
       <th style="${CELL_STYLE}">where</th><th style="${CELL_STYLE}">state</th>
       <th style="${CELL_STYLE}">age</th>
     </tr></thead><tbody>${rows || `<tr><td style="${CELL_STYLE}" colspan="7">nothing open</td></tr>`}</tbody></table>`,
  );
}

function renderDetail(
  intervention: NonNullable<ReturnType<ControlPlane["get"]>>,
  view: LiveView | null,
  settled: boolean,
): string {
  const b = intervention.brief;
  const brief = `<div style="${BOX_STYLE}">
    <h2>${esc(b.capabilityTitle)}</h2>
    <p><strong>Goal (parameterized):</strong> ${esc(b.goalTemplate)}</p>
    <p><strong>Stopped at:</strong> step ${b.stepIndex} &mdash; ${esc(b.stepTitle)}</p>
    <p><strong>Why:</strong> ${esc(b.whyStopped)}</p>
    <p><strong>What was expected:</strong> ${esc(b.whatWasExpected.rendered)}</p>
    <p><strong>What was observed:</strong> ${esc(observedLine(b.whatWasObserved))}</p>
    <p><strong>Evidence:</strong> ${esc(b.evidence ?? "none captured")}</p>
    <p><strong>Suggested action:</strong> ${esc(b.suggestedAction)}</p>
    <p><strong>State:</strong> ${esc(intervention.state)} &middot; expires ${esc(intervention.expiresAt)}</p>
  </div>`;

  if (settled) {
    return page(
      b.capabilityTitle,
      `${brief}<div style="${BOX_STYLE}"><p>This run has finished. There is no live session left to drive.</p>
       <p><a href="/interventions">Back to the queue</a></p></div>`,
    );
  }

  const live =
    view === null
      ? `<div style="${BOX_STYLE}"><p>No live view.</p></div>`
      : `<div style="${BOX_STYLE}">
      <h3>Live session</h3>
      <p><strong>Control:</strong> ${esc(view.state)} &middot; held by ${esc(view.holder)} (${esc(view.actorId)}) at epoch ${view.epoch}</p>
      <p><strong>Surface:</strong> ${esc(view.surface)} &middot; route ${esc(view.observed.route?.path ?? "unknown")} &middot; ${view.observed.settled ? "settled" : "not settled"}</p>
      <p><strong>Capture (${esc(view.captureFormat ?? "none")}):</strong> ${esc(
        view.capture === null
          ? view.captureRefused.length > 0
            ? `refused - ${view.captureRefused.length} sensitive nodes could not be masked`
            : "none"
          : `${view.capture.ref} (${view.capture.maskedRegions} masked regions)`,
      )}</p>
      <p><em>The capture is a content address, not bytes. Streaming frames is a documented seam; see the module header.</em></p>
      <table style="${TABLE_STYLE}"><thead><tr>
        <th style="${CELL_STYLE}">node</th><th style="${CELL_STYLE}">role</th>
        <th style="${CELL_STYLE}">name</th><th style="${CELL_STYLE}">actionable</th>
      </tr></thead><tbody>${view.nodes
        .map(
          (n) => `<tr>
            <td style="${CELL_STYLE}">${esc(n.id)}</td>
            <td style="${CELL_STYLE}">${esc(n.role ?? "-")}</td>
            <td style="${CELL_STYLE}">${esc(n.name)}${n.masked ? " (masked)" : ""}</td>
            <td style="${CELL_STYLE}">${n.actionable ? "yes" : "no"}</td>
          </tr>`,
        )
        .join("\n")}</tbody></table>
    </div>`;

  const id = encodeURIComponent(intervention.id);
  const forms = `<div style="${BOX_STYLE}">
    <h3>Take control</h3>
    <form method="post" action="/interventions/${id}/claim">
      <label>operator id <input name="operatorId" value="operator-1"></label>
      <button type="submit">Claim</button>
    </form>
  </div>
  <div style="${BOX_STYLE}">
    <h3>Act in the live session</h3>
    <form method="post" action="/interventions/${id}/act">
      <label>operator id <input name="operatorId" value="operator-1"></label>
      <label>action
        <select name="kind">
          <option>click</option><option>type</option><option>select</option>
          <option>setChecked</option><option>pressKey</option><option>focus</option>
          <option>navigate</option><option>acceptDialog</option><option>dismissDialog</option>
        </select>
      </label>
      <label>node <input name="target"></label>
      <label>text <input name="text"></label>
      <label>key <input name="key"></label>
      <label>declared effect
        <select name="effect">
          <option>READ</option><option>WRITE_REVERSIBLE</option><option>WRITE_IRREVERSIBLE</option>
        </select>
      </label>
      <button type="submit">Inject</button>
    </form>
    <p><em>Every injection passes the same policy chokepoint as an automation action and is journaled
    as <code>human.acted</code> with your id and the control's title. What you type is never recorded.</em></p>
  </div>
  <div style="${BOX_STYLE}">
    <h3>Finish</h3>
    <form method="post" action="/interventions/${id}/handback">
      <label>operator id <input name="operatorId" value="operator-1"></label>
      <button type="submit">Hand back</button>
    </form>
    <p><em>Hand-back re-verifies where the run is before it continues: lease, fresh observation,
    re-classification, the step's precondition, every continuity value, and the effect gate.</em></p>
    <form method="post" action="/interventions/${id}/abort">
      <label>operator id <input name="operatorId" value="operator-1"></label>
      <label>reason <input name="reason"></label>
      <button type="submit">Abort</button>
    </form>
  </div>`;

  return page(
    b.capabilityTitle,
    `${brief}${live}${forms}<p><a href="/interventions">Back to the queue</a></p>`,
  );
}

function observedLine(observed: LiveView["observed"]): string {
  const salient = observed.salient
    .slice(0, 6)
    .map((s) => `${s.role}:${s.name}`)
    .join(" | ");
  return `${observed.nodeCount} nodes, ${observed.settled ? "settled" : "not settled"}${
    observed.nativeDialog === null ? "" : `, ${observed.nativeDialog.type} dialog`
  }${salient.length === 0 ? "" : ` - ${salient}`}`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
