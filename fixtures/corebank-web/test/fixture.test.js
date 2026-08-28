// Acceptance tests for the hostile fixture.
//
// Two properties are being asserted, and they are the two the fixture exists to provide:
//
//   1. EVERY fault in the registry is reachable by a documented trigger and produces the response
//      the taxonomy needs. The scenario table is driven off the exported `FAULTS` registry rather
//      than a hand-written list, so adding a fault without an assertion FAILS this file instead of
//      silently shipping an untested fault.
//   2. The two tenants serve materially different labels for the same capability, and differ in
//      markup detail in ways that break index-based automation.
//
// Plus the invariants that make the fixture worth automating at all: no test ids, no `data-*`, a
// real frameset, a nested iframe, and a write that actually writes.
//
// Everything runs against an ephemeral port in-process. No network, no credentials, no browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FAULTS } from "../src/faults.js";
import { TENANT_IDS, startFixtureServer } from "../src/server.js";

/** @type {{ origin: string, close: () => Promise<void> }} */
let fixture;

beforeAll(async () => {
  fixture = await startFixtureServer({});
});

afterAll(async () => {
  await fixture.close();
});

/**
 * A client pinned to one fixture session. Session isolation is the fixture's concurrency story, so
 * every test gets its own and they are safe to run in parallel.
 * @param {string} sessionId
 */
const client = (sessionId) => {
  const headers = { "x-corebank-session": sessionId };
  const get = async (path, init = {}) => {
    const res = await fetch(`${fixture.origin}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
  const post = (path, form, init = {}) =>
    get(path, {
      ...init,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers ?? {}) },
      body: form,
    });
  return { get, post, sessionId };
};

const HOSTILE_PAGES = [
  "/",
  "/banner",
  "/nav",
  "/search",
  "/search/results?lastName=PARKER",
  "/member/10041",
  "/member/10041/subaccounts",
  "/member/10041/subaccount/new",
  "/cb/",
  "/cb/search/results?lastName=PARKER",
  "/cb/member/10041",
];

describe("the surface is hostile in the ways that matter", () => {
  it("serves a real frameset, not divs pretending to be one", async () => {
    const { body } = await client("frameset").get("/");
    expect(body).toContain("<frameset");
    expect(body).toContain('<frame name="banner"');
    expect(body).toContain('<frame name="nav"');
    expect(body).toContain('<frame name="content"');
  });

  it("nests an iframe inside the content frame, so the screen spans two framing levels", async () => {
    const { body } = await client("nested").get("/member/10041");
    expect(body).toContain('<iframe name="subacct"');
    const inner = await client("nested").get("/member/10041/subaccounts");
    expect(inner.body).toContain("Share Account - Regular");
  });

  it("carries no test ids and no data-* attributes on any screen", async () => {
    for (const path of HOSTILE_PAGES) {
      const { body } = await client("noids").get(path);
      expect(body, `data-* attribute in ${path}`).not.toMatch(/\sdata-[a-z]/i);
      expect(body, `test id in ${path}`).not.toMatch(/testid|test-id|qa-id|automation-id/i);
    }
  });

  it("uses generated ids, font tags and nbsp spacers rather than semantic markup", async () => {
    const { body } = await client("legacy").get("/search");
    expect(body).toMatch(/id="ctl00_ctl32_g_9a1_txtMemberId"/);
    expect(body).toContain("<font face=");
    expect(body).toContain("&nbsp;");
    expect(body).not.toContain("<label");
  });

  it("labels itself as a synthetic-data test fixture on every screen", async () => {
    for (const path of HOSTILE_PAGES) {
      const { body } = await client("banner").get(path);
      expect(body, path).toContain("SYNTHETIC DATA ONLY");
    }
  });

  it("makes the target row findable by its member id cell but not by row index or name", async () => {
    const { body } = await client("rows").get("/search/results?lastName=PARKER");
    // Two members share a displayed name, so "the Parker row" is ambiguous by construction.
    expect(body.match(/PARKER, JAMIE \(SYNTHETIC\)/g)).toHaveLength(2);
    expect(body).toContain(">10044<");
    expect(body).toContain(">10045<");
    // ...and the grid has no <th>, no scope and no caption to anchor a column read to.
    expect(body).not.toContain("<th");
    expect(body).not.toContain("scope=");
    expect(body).not.toContain("<caption");
  });
});

describe("the flow: search -> detail -> open sub-account -> confirmation", () => {
  it("completes through the in-page modal and actually writes", async () => {
    const c = client("happy-modal");
    const results = await c.get("/search/results?memberId=10041");
    expect(results.body).toContain(">10041<");
    expect(results.body).toContain('href="/member/10041"');

    const detail = await c.get("/member/10041");
    expect(detail.body).toContain('value="Open Sub-Account"');

    const form = await c.get("/member/10041/subaccount/new");
    expect(form.body).toContain('id="ctl00_ctl32_g_9a1_ddlSubType"');
    expect(form.body).toContain('action="/member/10041/subaccount/confirm"');

    const confirm = await c.post("/member/10041/subaccount/confirm", "subType=S1&deposit=250.00");
    expect(confirm.body).toContain('aria-modal="true"');
    expect(confirm.body).toContain("Confirm Sub-Account");
    expect(confirm.body).toContain('id="ctl00_ctl32_g_9a1_btnConfirm"');

    const before = await c.get("/__fixture/state");
    expect(JSON.parse(before.body).members[0].subAccounts).toBe(1);

    const commit = await c.post("/member/10041/subaccount/commit", "subType=S1&deposit=250.00");
    expect(commit.body).toContain("Sub-Account Opened");
    expect(commit.body).toContain("10041-0002");
    expect(commit.body).toContain("TXN-000001");

    const after = await c.get("/__fixture/state");
    expect(JSON.parse(after.body).members[0].subAccounts).toBe(2);
  });

  it("offers a native confirm() as a separate observation channel", async () => {
    const c = client("happy-native");
    await c.get("/search?dialog=native");
    const form = await c.get("/member/10042/subaccount/new");
    // The native path skips the in-page modal entirely: the submit is guarded by window.confirm and
    // posts straight to the write.
    expect(form.body).toContain("window.confirm(");
    expect(form.body).toContain('action="/member/10042/subaccount/commit"');
    expect(form.body).not.toContain('aria-modal="true"');
  });

  it("writes again on a second commit - the fixture is deliberately not idempotent", async () => {
    const c = client("double-write");
    await c.post("/member/10043/subaccount/commit", "subType=S1&deposit=1.00");
    await c.post("/member/10043/subaccount/commit", "subType=S1&deposit=1.00");
    const state = JSON.parse((await c.get("/__fixture/state")).body);
    const member = state.members.find((m) => m.memberId === "10043");
    expect(member.subAccounts).toBe(4);
  });

  it("resets to seed state through the documented reset hook", async () => {
    const c = client("reset");
    await c.post("/member/10041/subaccount/commit", "subType=S1&deposit=1.00");
    expect(JSON.parse((await c.get("/__fixture/state")).body).members[0].subAccounts).toBe(2);
    await c.get("/__fixture/reset");
    expect(JSON.parse((await c.get("/__fixture/state")).body).members[0].subAccounts).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// Fault coverage. The table is keyed by fault id and checked against the registry below, so a fault
// added without a scenario fails the suite rather than shipping untested.
// ------------------------------------------------------------------------------------------------

/**
 * @type {Record<string, { arm?: string, run: (c: ReturnType<typeof client>) => Promise<{ status: number, body: string }>, expect: (r: { status: number, body: string }) => void }>}
 */
const SCENARIOS = {
  "validation-error": {
    run: (c) => c.post("/member/10041/subaccount/confirm", "subType=S1&deposit=250.00"),
    expect: (r) => {
      expect(r.status).toBe(200);
      expect(r.body).toContain("not enabled for this branch");
      // The write must NOT have happened, and the caller is back on the form.
      expect(r.body).toContain('id="ctl00_ctl32_g_9a1_ddlSubType"');
    },
  },
  "not-found": {
    run: (c) => c.get("/search/results?lastName=PARKER"),
    expect: (r) => {
      expect(r.status).toBe(200);
      expect(r.body).toContain("No members matched the search criteria.");
      expect(r.body).not.toContain("PARKER, JAMIE (SYNTHETIC)");
      // The empty grid still renders its header row - the same shape the expiry screen has, which
      // is what makes telling them apart a real test of the classifier.
      expect(r.body).toContain("(0 records)");
    },
  },
  "permission-denied-record": {
    run: (c) => c.post("/member/10041/subaccount/commit", "subType=S1&deposit=10.00"),
    expect: (r) => {
      expect(r.body).toContain("is restricted");
      expect(r.body).toContain("CB-4417");
      expect(r.body).not.toContain("Sub-Account Opened");
    },
  },
  "permission-denied-role": {
    run: (c) => c.post("/member/10041/subaccount/commit", "subType=S1&deposit=10.00"),
    expect: (r) => {
      expect(r.body).toContain("not authorized for function OPEN_SUBACCOUNT");
      expect(r.body).toContain("CB-2203");
      expect(r.body).not.toContain("Sub-Account Opened");
    },
  },
  interstitial: {
    run: (c) => c.get("/member/10041"),
    expect: (r) => {
      expect(r.body).toContain("System Notice");
      expect(r.body).toContain('aria-modal="true"');
      // A genuine full-page click interceptor sits under the panel.
      expect(r.body).toContain("_pnlNotice_dim");
      expect(r.body).toContain('value="Acknowledge"');
    },
  },
  "native-dialog": {
    run: (c) => c.get("/member/10041"),
    expect: (r) => {
      expect(r.body).toContain("window.confirm(");
      // Parser-blocking: it must sit inside the body, ahead of the content it is holding up.
      const dialogAt = r.body.indexOf("window.confirm(");
      expect(dialogAt).toBeGreaterThan(r.body.indexOf("<body"));
      expect(dialogAt).toBeLessThan(r.body.indexOf("<b>Member Detail</b>"));
    },
  },
  "session-timeout": {
    run: (c) => c.get("/member/10041"),
    expect: (r) => {
      expect(r.status).toBe(200);
      expect(r.body).toContain("Your session has ended due to inactivity.");
      expect(r.body).toContain('value="Sign In"');
      expect(r.body).not.toContain("Member Detail");
    },
  },
  "slow-load": {
    arm: "slow-load&_faultDelayMs=250",
    run: async (c) => {
      const started = Date.now();
      const r = await c.get("/search/results?lastName=PARKER");
      return { ...r, elapsed: Date.now() - started };
    },
    expect: (r) => {
      expect(r.elapsed).toBeGreaterThanOrEqual(200);
      // The page does eventually arrive complete: this is transient slowness, not a failure.
      expect(r.body).toContain("PARKER, JAMIE (SYNTHETIC)");
    },
  },
  "app-error": {
    run: (c) => c.get("/member/10041"),
    expect: (r) => {
      expect(r.status).toBe(500);
      expect(r.body).toContain("Server Error in");
      expect(r.body).toContain("System.NullReferenceException");
    },
  },
  "torn-render": {
    run: (c) => c.get("/search/results?lastName=PARKER"),
    expect: (r) => {
      expect(r.status).toBe(200);
      // Truncated INSIDE the grid: the last row is left open, and the table never closes.
      const gridAt = r.body.indexOf('<table id="ctl00_ctl32_g_9a1_grdResults"');
      expect(gridAt).toBeGreaterThan(-1);
      expect(r.body.slice(gridAt)).not.toContain("</table>");
      expect(r.body).not.toContain("</body>");
      expect(r.body.trimEnd().endsWith("<td nowrap>")).toBe(true);
    },
  },
};

describe("fault injection", () => {
  it("has a scenario for every fault in the registry", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(FAULTS).sort());
  });

  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    it(`${id} is reachable via the query parameter`, async () => {
      const c = client(`q-${id}`);
      await c.get(`/search?_fault=${scenario.arm ?? id}`);
      scenario.expect(await scenario.run(c));
    });

    it(`${id} is reachable via the request header`, async () => {
      const c = client(`h-${id}`);
      await c.get("/search", {
        headers: { "x-corebank-fault": id, "x-corebank-fault-delay": "250" },
      });
      scenario.expect(await scenario.run(c));
    });

    it(`${id} is reachable via the control endpoint`, async () => {
      const c = client(`e-${id}`);
      const armed = await c.get(`/__fixture/fault?set=${id}&delayMs=250`);
      expect(JSON.parse(armed.body).armed.id).toBe(id);
      scenario.expect(await scenario.run(c));
    });
  }
});

describe("fault scoping", () => {
  it("is per session: arming one session does not touch another", async () => {
    const armed = client("scoped-armed");
    const clean = client("scoped-clean");
    await armed.get("/__fixture/fault?set=not-found");
    const a = await armed.get("/search/results?lastName=PARKER");
    const b = await clean.get("/search/results?lastName=PARKER");
    expect(a.body).toContain("No members matched");
    expect(b.body).toContain("PARKER, JAMIE (SYNTHETIC)");
  });

  it("is per screen: a fault armed for the commit screen leaves earlier screens alone", async () => {
    const c = client("scoped-screen");
    await c.get("/__fixture/fault?set=permission-denied-role");
    const detail = await c.get("/member/10041");
    expect(detail.body).toContain("Member Detail");
    const commit = await c.post("/member/10041/subaccount/commit", "subType=S1&deposit=1.00");
    expect(commit.body).toContain("not authorized for function OPEN_SUBACCOUNT");
  });

  it("re-scopes to any screen on request", async () => {
    const c = client("scoped-any");
    await c.get("/__fixture/fault?set=app-error&at=any");
    expect((await c.get("/search")).status).toBe(500);
  });
});

describe("fault modes follow the outcome-vs-failure rule", () => {
  it("outcome-shaped faults are sticky: the answer is stable under retry", async () => {
    const c = client("mode-sticky");
    await c.get("/__fixture/fault?set=not-found");
    expect((await c.get("/search/results?lastName=PARKER")).body).toContain("No members matched");
    expect((await c.get("/search/results?lastName=PARKER")).body).toContain("No members matched");
  });

  it("failure-shaped faults fire once: the next attempt can succeed", async () => {
    const c = client("mode-once");
    await c.get("/__fixture/fault?set=app-error");
    expect((await c.get("/member/10041")).status).toBe(500);
    expect((await c.get("/member/10041")).status).toBe(200);
  });

  it("honours an explicit mode override", async () => {
    const c = client("mode-override");
    await c.get("/__fixture/fault?set=app-error&mode=sticky");
    expect((await c.get("/member/10041")).status).toBe(500);
    expect((await c.get("/member/10041")).status).toBe(500);
  });
});

describe("session expiry is recoverable by signing back in", () => {
  it("holds the sign-in screen until POST /signin, then resumes", async () => {
    const c = client("expiry");
    await c.get("/__fixture/fault?set=session-timeout");
    expect((await c.get("/member/10041")).body).toContain("session has ended");
    expect((await c.get("/search")).body).toContain("session has ended");
    const redirect = await c.post("/signin", "next=%2Fmember%2F10041");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/member/10041");
    expect((await c.get("/member/10041")).body).toContain("Member Detail");
  });

  it("refuses an off-site return target", async () => {
    const c = client("expiry-redirect");
    const redirect = await c.post("/signin", "next=https%3A%2F%2Fexample.invalid%2F");
    expect(redirect.headers.get("location")).toBe("/search");
  });
});

describe("organic conditions that need no fault injection", () => {
  it("rejects a caller-supplied member number that is not five digits", async () => {
    const { body } = await client("organic-validation").get("/search/results?memberId=ABC");
    expect(body).toContain("Member ID must be exactly 5 digits.");
  });

  it("returns an empty grid for a member number that is not on file", async () => {
    const { body } = await client("organic-notfound").get("/search/results?memberId=99999");
    expect(body).toContain("No members matched the search criteria.");
  });

  it("refuses the write on a restricted member record", async () => {
    const c = client("organic-restricted");
    const r = await c.post("/member/10046/subaccount/commit", "subType=S1&deposit=5.00");
    expect(r.body).toContain("is restricted");
  });

  it("refuses the write on a closed membership", async () => {
    const c = client("organic-closed");
    const r = await c.post("/member/10047/subaccount/commit", "subType=S1&deposit=5.00");
    expect(r.body).toContain("is closed");
  });

  it("rejects a product code the branch does not offer, with no fault armed", async () => {
    const c = client("organic-product");
    const r = await c.post("/member/10041/subaccount/confirm", "subType=S9&deposit=5.00");
    expect(r.body).toContain("Product code S9 is not enabled for this branch.");
  });
});

describe("two tenants of one vendor product", () => {
  it("serve materially different labels for the same fields", async () => {
    const rb = (await client("t-rb").get("/search/results?lastName=PARKER")).body;
    const su = (await client("t-su").get("/cb/search/results?lastName=PARKER")).body;

    expect(rb).toContain("Member ID");
    expect(rb).not.toContain("Member Number");
    expect(su).toContain("Member Number");
    expect(su).not.toContain("Member ID");

    expect(rb).toContain("Share Balance");
    expect(su).toContain("Savings Balance");

    expect(rb).toContain('value="Search"');
    expect(su).toContain('value="Find"');

    expect(rb).toContain("Search Results");
    expect(su).toContain("Member Search Results");
  });

  it("differ on the sub-account vocabulary too", async () => {
    const rb = (await client("t-rb2").get("/member/10041")).body;
    const su = (await client("t-su2").get("/cb/member/10041")).body;
    expect(rb).toContain('value="Open Sub-Account"');
    expect(su).toContain('value="Add Sub-Account"');
    expect(rb).toContain("Share Accounts");
    expect(su).toContain("Savings Accounts");
  });

  it("keep the row action identical, so not every difference needs an overlay", async () => {
    const rb = (await client("t-rb3").get("/search/results?lastName=PARKER")).body;
    const su = (await client("t-su3").get("/cb/search/results?lastName=PARKER")).body;
    expect(rb).toContain(">Open</font></a>");
    expect(su).toContain(">Open</font></a>");
  });

  it("shift every results column by one on summit, breaking index-based row reads", async () => {
    const su = (await client("t-su4").get("/cb/search/results?lastName=PARKER")).body;
    expect(su).toContain('type="radio"');
    const grid = su.slice(su.indexOf('<table id="ctl00_ctl41_g_c7e2_gvMembers"'));
    expect(grid.indexOf(">Sel<")).toBeLessThan(grid.indexOf(">Member Number<"));
  });

  it("generate different element ids for the same logical field", async () => {
    const rb = (await client("t-rb5").get("/search")).body;
    const su = (await client("t-su5").get("/cb/search")).body;
    expect(rb).toContain('id="ctl00_ctl32_g_9a1_txtMemberId"');
    expect(su).toContain('id="ctl00_ctl41_g_c7e2_txtMbrNo"');
  });

  it("mount the same routes under a different base path", async () => {
    const su = (await client("t-su6").get("/cb/")).body;
    expect(su).toContain('src="/cb/search"');
    expect(su).toContain("Summit Community Bank");
    const rb = (await client("t-rb6").get("/")).body;
    expect(rb).toContain('src="/search"');
    expect(rb).toContain("Riverbend Federal Credit Union");
  });

  it("inject every fault on both tenants", async () => {
    const c = client("t-faults");
    await c.get("/cb/__fixture/fault?set=not-found");
    const su = await c.get("/cb/search/results?lastName=PARKER");
    expect(su.body).toContain("No members matched the search criteria.");
  });
});

describe("the README documents what the server actually does", () => {
  // The acceptance criterion for this unit is "each fault is reachable by a DOCUMENTED trigger".
  // Documentation that can rot is not documentation, so the README is an asserted artifact.
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

  it("names every fault in the registry", () => {
    for (const id of Object.keys(FAULTS)) {
      expect(readme, `fault ${id} is undocumented`).toContain(`\`${id}\``);
    }
  });

  it("documents all three trigger mechanisms", () => {
    expect(readme).toContain("_fault=");
    expect(readme).toContain("X-CoreBank-Fault");
    expect(readme).toContain("/__fixture/fault?set=");
  });

  it("documents the modifiers and the reset hook", () => {
    expect(readme).toContain("_faultAt=");
    expect(readme).toContain("_faultMode=");
    expect(readme).toContain("_faultDelayMs=");
    expect(readme).toContain("/__fixture/reset");
  });

  it("documents both tenants and their base paths", () => {
    for (const id of TENANT_IDS) expect(readme).toContain(id);
    expect(readme).toContain("/cb");
  });

  it("says the data is synthetic", () => {
    expect(readme).toContain("ALL DATA IS SYNTHETIC");
  });
});
