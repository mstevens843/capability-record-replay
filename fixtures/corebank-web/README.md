# `fixtures/corebank-web` — the hostile surface

A zero-dependency `node:http` server that impersonates a frameset-era credit-union back office:
**CoreBank Servicing**, one vendor product, deployed at two tenants.

> **ALL DATA IS SYNTHETIC.** Every member, name, account number, balance and branch in this fixture
> is invented, and every screen carries a visible banner saying so. Nothing here is, resembles, or
> is derived from a real person, a real account or a real institution. This is a test fixture, not a
> financial system, and it must never be pointed at anything that is.

## Why it exists

The assignment permits "an intentionally hostile surface". We build one because a public demo site
**cannot** be made to expire a session, deny an entitlement, or tear a response mid-render on cue —
which makes most of the error taxonomy in `docs/SPEC.md` §4.2 undemonstrable. Every fault below maps
to a numbered row of that table, and the mapping is recorded on the fault itself in
[`src/faults.js`](src/faults.js) so nobody has to reconstruct later what a scenario was meant to
prove.

The second reason is discrimination. A clean, semantically marked-up app would let a CSS-selector
design pass. This one will not: the two tenants have different generated element ids, different
field labels, and a results grid whose column indices differ by one — so an artifact that stores a
selector or a column index passes on `riverbend` and silently reads the wrong cell on `summit`.

## Run it

```bash
pnpm -F @crr/fixture-corebank-web start          # http://127.0.0.1:8731
pnpm -F @crr/fixture-corebank-web start -- 9000  # or pick a port
pnpm -F @crr/fixture-corebank-web test           # ephemeral port, no network, no credentials
```

66 tests pass as of this writing (`pnpm -F @crr/fixture-corebank-web test`, vitest 2.1.9, Node
22.22.1). They boot the server on an ephemeral port in-process and assert that every fault in the
registry is reachable by each of its three documented triggers, that the two tenants serve materially
different labels, and that no screen carries a test id or a `data-*` attribute.

Programmatically — this is how `@crr/surface-browser` and the conformance suite boot it:

```ts
import { startFixtureServer, FAULTS, TENANTS } from "@crr/fixture-corebank-web";

const fixture = await startFixtureServer({});   // port 0 → ephemeral
// fixture.origin → "http://127.0.0.1:54321"
await fixture.close();
```

| Export | What it is |
|---|---|
| `createFixtureServer()` | An unbound `http.Server`. Call `.listen()` yourself. |
| `startFixtureServer({ port?, host? })` | Boots and resolves `{ server, port, origin, close }`. `port: 0` (the default) binds an ephemeral port, so many servers can coexist in one process. |
| `FAULTS` | The fault registry: id, default screen, default mode, the SPEC §4.2 row each one produces. |
| `TENANTS`, `TENANT_IDS` | Tenant configuration, including base paths and the full label vocabulary. |

## The flow

**member search → member detail → open sub-account → confirmation.**

| Screen id | Route (riverbend) | What it is |
|---|---|---|
| — | `GET /` | The **frameset**: `banner` / `nav` / `content`. A real `<frameset>`, not divs. |
| — | `GET /banner`, `GET /nav` | The chrome frames. |
| `search` | `GET /search` | The member search form. |
| `results` | `GET /search/results?…` | The same page, with the results grid appended — a WebForms-style postback, not a separate page. |
| `detail` | `GET /member/:memberId` | Member detail. Contains a **nested `<iframe name="subacct">`**. |
| `subaccounts` | `GET /member/:memberId/subaccounts` | The nested frame's contents: the existing sub-account list. |
| `new` | `GET /member/:memberId/subaccount/new` | The open-sub-account form. |
| `confirm` | `POST /member/:memberId/subaccount/confirm` | The **in-page modal** confirmation step. |
| `commit` | `POST /member/:memberId/subaccount/commit` | **The write.** |
| — | `GET`/`POST /signin` | The session-expiry sign-in screen and its postback. |

Summit's routes are the same templates under `/cb` — `GET /cb/member/10041`, and so on. Screen ids
are what fault scoping uses; see `_faultAt` below.

**The write is deliberately not idempotent.** Posting `/commit` twice opens two sub-accounts, exactly
as the real thing would. `restartSafeUpToPc`, the dry-run verification mode and SPEC §4.2 row 33
(`effect-in-doubt`) only mean anything against a fixture that will actually double-write.

### The two confirmation channels

The spec treats a native dialog as an observation channel distinct from the DOM, so the fixture puts
the same decision on either one:

| Mode | How | What the form does |
|---|---|---|
| `modal` (default) | — | Submit posts to `/confirm`, which re-renders the form under a `role="dialog" aria-modal="true"` panel and a **full-page click-intercepting dim layer**. Confirm posts on to `/commit`. |
| `native` | `?dialog=native` or `X-CoreBank-Dialog: native` | Submit is guarded by a real `window.confirm()` and posts **straight to `/commit`**. No in-page modal at all. |

The mode is sticky on the session; `?dialog=modal` switches back.

## Faults

Ten fault ids covering the eight fault kinds the spec calls for. Permission denial is split, because
SPEC §4.2 rows 7 and 8 are the same screen meaning opposite things (a fact about the **record** is an
outcome; a fact about the **session's role** is a hard failure) and a fixture that cannot produce
both makes that distinction untestable. `native-dialog` is separated from `interstitial` for the same
reason: one is in the DOM, one is not.

### Triggers

Three equivalent ways to arm a fault. All are **scoped to the session**, so concurrent runs against
one server do not interfere.

```bash
# 1. query parameter, on any request. Arms for the session; fires on this same request if the
#    request is already at the fault's screen.
curl 'http://127.0.0.1:8731/search?_fault=not-found'
curl 'http://127.0.0.1:8731/search/results?lastName=PARKER&_fault=torn-render'

# 2. request header, for a driver that would rather not touch the URL.
curl -H 'X-CoreBank-Fault: session-timeout' http://127.0.0.1:8731/member/10041

# 3. control endpoint, which reports back what it armed.
curl 'http://127.0.0.1:8731/__fixture/fault?set=slow-load&delayMs=4000'
curl 'http://127.0.0.1:8731/__fixture/fault?clear=1'
```

Sessions are identified by the `CBSESSIONID` cookie (frames inherit it, so arming on the frameset URL
arms the frames it spawns). A driver can also pin one explicitly with `X-CoreBank-Session: <id>` or
`?_sid=<id>`; the session id is echoed on every response in `X-CoreBank-Session` and in an HTML
comment at the top of every document.

An unknown fault name is **not** an error — it arms nothing and the control endpoint replies
`{"ok": false}`. A typo that silently arms nothing is easier to debug than a 400 served into a frame
whose body nobody reads.

### The faults

| id | Default screen | Default mode | Response | SPEC §4.2 |
|---|---|---|---|---|
| `validation-error` | `confirm` | sticky | Back to the open-sub-account form under a red banner: *"Product code S1 is not enabled for this branch."* No write. | row 5 — validation error on an **artifact-literal**-bound value; **hard failure** |
| `not-found` | `results` | sticky | Empty results grid — header row, `(0 records)` — plus *"No members matched the search criteria."* | row 6 — `MEMBER_NOT_FOUND`; **outcome** |
| `permission-denied-record` | `commit` | sticky | Refusal screen, ref `CB-4417`: *"Member 10041 is restricted. A member services supervisor must service this record."* No write. | row 7 — denial scoped to the **record**; **outcome** |
| `permission-denied-role` | `commit` | sticky | Near-identical refusal screen, ref `CB-2203`: *"Your role TELLER1 is not authorized for function OPEN_SUBACCOUNT."* No write. | row 8 — denial scoped to the **session role**; **hard failure** |
| `interstitial` | `detail` | once | A blocking in-page *System Notice* modal with an `Acknowledge` button, over a full-page click interceptor. **The same widget the confirmation step uses.** | rows 9/10 — recoverable if declared, `undeclared-dialog` if not |
| `native-dialog` | `detail` | once | A real `window.confirm()` in a parser-blocking inline script immediately after `<body>`. The document is genuinely held open until something answers it. | rows 10/21 — a distinct observation channel that also stalls `perceive` |
| `session-timeout` | `detail` | once | HTTP 200 sign-in screen, *"Your session has ended due to inactivity."* **The session stays expired** — every content screen serves it — until `POST /signin`, which redirects to `next`. | rows 11–13 — recoverable via `reauthenticate`, else unrecoverable |
| `slow-load` | `results` | once | Headers and the page chrome flush immediately; the data follows after `delayMs` (default 1200). The page does arrive complete. | rows 14/15 — transient slowness, or `did-not-settle` if `delayMs` exceeds the settle budget |
| `app-error` | `detail` | once | **HTTP 500** with a vendor-style unhandled-exception page and a synthetic `System.NullReferenceException` stack trace. | row 16 — `app-error`; **hard failure** |
| `torn-render` | `results` | once | Chunked response truncated **inside the results grid**, leaving an open `<tr>` and an open `<td>` and no `</table>` or `</body>`. | §4.4 band B0 — the torn read the quiescence gate exists to catch |

Aliases accepted on the wire: `permission-denied` → `permission-denied-record`, `member-not-found` →
`not-found`, `app-500` → `app-error`, `partial-render` → `torn-render`.

### Modifiers

| Query | Header | Meaning |
|---|---|---|
| `_faultAt=<screen>` | `X-CoreBank-Fault-At` | Fire on a different screen. Any screen id from the flow table, or `any` for the next content screen of any kind. On the control endpoint: `&at=`. |
| `_faultMode=once\|sticky` | `X-CoreBank-Fault-Mode` | Override the default mode. On the control endpoint: `&mode=`. |
| `_faultDelayMs=<n>` | `X-CoreBank-Fault-Delay` | `slow-load` only. On the control endpoint: `&delayMs=`. |

**Why the default modes differ.** `docs/design/OPEN-QUESTIONS-RESOLVED.md` Q1 settles it:

> An outcome is a fact about the request or the record that will still be true on the next attempt.
> A failure is a fact about the system that might not be.

So the faults that stand for business outcomes, and the one that stands for a stable environment
truth (a role entitlement does not heal itself), are **sticky** — a replay engine that retries them
must keep getting the same answer. The faults that stand for this-attempt failures are **once**, so a
retry can succeed and a recovery can actually be graded.

### Fault scoping

A fault fires only on the screen it is scoped to. Arming `permission-denied-role` (screen `commit`)
leaves the search and detail screens working normally, so a run reaches the write before it is
refused — which is the only way to test that the engine got that far. Use `_faultAt=any` when you
want the next content screen of any kind to take it.

## Conditions that need no fault injection at all

Several rows of the taxonomy are reachable organically, which is worth more than an injected version
because nothing about them is a test hook:

| Do this | You get |
|---|---|
| `GET /search/results?memberId=ABC` | *"Member ID must be exactly 5 digits."* — SPEC §4.2 **row 4**: a validation error on a value the **caller** supplied, which is an **outcome**. The identical banner produced by the `validation-error` fault is row 5, a hard failure, because there the rejected value came from the artifact. |
| `GET /search/results?memberId=99999` | An empty grid and *"No members matched"* — a real `MEMBER_NOT_FOUND`. |
| `POST /member/10046/subaccount/commit` | Member 10046 is `RESTRICTED`: the record-scoped refusal. |
| `POST /member/10047/subaccount/commit` | Membership 10047 is `CLOSED`: *"Sub-accounts cannot be opened on a closed membership."* |
| `POST …/confirm` with `subType=S9` | *"Product code S9 is not enabled for this branch."* — the branch does not offer Holiday Club, forever, for every caller. |
| `GET /search/results?lastName=PARKER` | Two rows with the **same displayed name** (10044, 10045). "The Parker row" is ambiguous; "the row whose Member ID cell is 10045" is not. |

## Control endpoints

Available at the bare root and under every tenant base path (`/__fixture/…` and `/cb/__fixture/…`),
and always scoped to the calling session.

| Endpoint | Does |
|---|---|
| `GET /__fixture/faults` | The fault registry and the tenant list, as JSON. |
| `GET /__fixture/fault?set=<id>[&at=][&mode=][&delayMs=]` | Arms a fault; replies with what it armed. |
| `GET /__fixture/fault?clear=1` | Disarms. |
| `GET /__fixture/state` | Session state: armed fault, expiry, dialog mode, per-member sub-account counts. |
| `GET`/`POST /__fixture/reset` | Resets the session to seed state. |

`reset` is the hook SPEC §6.6 calls for: it is what lets verification replay run in `replay-reset`
mode and be graded `full` rather than `partial-up-to-irreversible`. **Real core banking has no such
hook**, which is exactly why the spec treats that mode as fixture-only.

## The two tenants

Same code, same product, same step sequence, same roles, configured differently at go-live.

| | `riverbend` | `summit` |
|---|---|---|
| Base path | `/` | `/cb` |
| Institution | Riverbend Federal Credit Union | Summit Community Bank |
| Product version | CoreBank Servicing 8.2.14 | CoreBank Servicing 8.4.02 |
| Member identifier label | **Member ID** | **Member Number** |
| Surname field | Last Name | Surname |
| Search submit | `Search` | `Find` |
| Results heading | Search Results | Member Search Results |
| Name column | Name | Member Name |
| Balance column | **Share Balance** | **Savings Balance** |
| Status column | Status | Acct Status |
| Savings product | **Share Account** | **Savings Account** |
| Sub-account list | Share Accounts | Savings Accounts |
| Open control | **Open Sub-Account** | **Add Sub-Account** |
| Type / deposit labels | Sub-Account Type / Initial Deposit | Account Type / Opening Deposit |
| Confirm modal | Confirm Sub-Account · `Confirm` / `Cancel` | Confirm New Account · `Yes` / `No` |
| Generated id prefix | `ctl00_ctl32_g_9a1` | `ctl00_ctl41_g_c7e2` |
| Member field id | `…_txtMemberId` | `…_txtMbrNo` |
| Font | Arial | Verdana |
| Layout nesting | 1 wrapper table | 2 wrapper tables |
| Results grid | 5 columns | **6 columns** — a leading `Sel` radio column |

**Identical on purpose:** the frame names (`banner`, `nav`, `content`, `subacct`), the roles of every
control, and the per-row action link text — `Open` on both. SPEC §9.4 makes the point that some
per-tenant differences need no overlay at all, and a fixture where *everything* differed would hide
it. An artifact step that says *activate the link named Open* replays unmodified on both tenants.

**Different on purpose, and load-bearing:** summit's leading radio column shifts every results column
index by one. An artifact that reads "cell 1 of the row" gets the member number on riverbend and a
radio button on summit. An artifact that reads the cell under the *Member Number* header gets the
right answer on both. The fixture is built so that the weaker design is the one that breaks.

## What makes the markup hostile

Enumerated in the header of [`src/pages.js`](src/pages.js), enforced by the test suite:

- a real `<frameset>` / `<frame>`, plus a **nested `<iframe>` inside the content frame**, so a full
  screen only exists after stitching an accessibility tree across two framing levels;
- nested layout tables, `<font face size color>`, `&nbsp;` spacers, `bgcolor` attributes;
- ASP.NET-generated element ids (`ctl00_ctl32_g_9a1_txtMemberId`) and `$`-separated form names,
  different per tenant;
- **no test ids, no `data-*` attributes, no `<label for>`** — field labels are adjacent table cells;
- **no `<th>`, no `scope=`, no `<caption>`** on the results grid; the header row is `<td bgcolor>`;
- results ordered by name rather than by member number, so the wanted row is rarely row one;
- no semantic landmarks anywhere.

Two invisible HTML comments are woven into the markup — `<!-- rpt:hdr -->` and `<!-- rpt:rowbuf -->`.
They are not identity a locator could use; they are the cut points `slow-load` and `torn-render`
slice at.

## What this fixture does *not* model

Stated plainly, because the fixture's job is to be honest about its own coverage:

- **No authentication of substance.** The sign-in screen exists to make session expiry recoverable;
  the passcode field is prefilled with the word `synthetic` and any post signs you back in. Session
  establishment is the session broker's problem (SPEC §7.6), not the program's.
- **No selector drift.** Markup is stable across restarts. The brief deliberately removed drift as
  the problem, so simulating it here would be answering a question nobody asked.
- **No network-layer failures.** No connection resets, no TLS errors, no partial writes at the socket
  level. `torn-render` models a torn *document*, not a torn *connection*.
- **No concurrency inside a session.** Two requests on one session are serialized by Node's event
  loop; there is no optimistic-locking conflict to discover.
- **Time is frozen.** Sub-account open dates and session ids are constants, and nothing calls
  `Date.now()` for content or `Math.random()` at all, so two runs that arm the same faults in the
  same order produce byte-identical pages. Non-determinism in this fixture is injected on purpose or
  not at all.
