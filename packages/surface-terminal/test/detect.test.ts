// The 31 detector assertions, over frozen grids, with nothing running.
//
// These are the spike's 31 (docs/design/spike-terminal-surface.md section 3.3), ported one for one
// so that the number means the same thing it meant there. They are the acceptance test for SPEC
// section 11 unit 20, and the reason there are exactly 31 rather than "a suite" is that each one
// pins a specific inference the detector makes about a character grid - a label anchor, a capacity,
// a gutter boundary, a focus signal - and losing any one of them is a silently wrong observation
// rather than a crash.
//
// No terminal, no child process, no clock. `detect` is a pure function of a `Grid`, so the entire
// perception layer of this driver is testable from a JSON file - which is the same property that
// makes the classifier testable from a frozen `Observation` one layer up.

import { describe, expect, it } from "vitest";
import { nodeById, nodesByRole, screen } from "./support/corpus.js";

const initial = screen("initial");
const typed = screen("typed");
const tabbed = screen("tabbed");
const detail = screen("detail");
const arrowed = screen("arrowed");
const notfound = screen("notfound");
const denied = screen("denied");
const invalid = screen("invalid");

describe("screen identity - the bottom band is this surface's URL", () => {
  it("1. reads the inquiry screen id", () => {
    expect(initial.screenId).toBe("MEMBER INQUIRY 01");
  });

  it("2. reads the detail screen id", () => {
    expect(detail.screenId).toBe("ACCOUNT LIST 02");
  });
});

describe("fields, labels and capacity", () => {
  it("3. finds exactly two textboxes on the inquiry screen", () => {
    expect(nodesByRole(initial, "textbox")).toHaveLength(2);
  });

  it("4. labels the account field from the text to its left", () => {
    expect(nodeById(initial, "textbox:account-number")?.name).toBe("Account Number");
  });

  it("5. reads the account field's capacity as 12 cells", () => {
    // The field's declared width falls straight out of the grid and becomes the maxLength of the
    // capability's typed parameter. A browser surface has to work for this number.
    expect(nodeById(initial, "textbox:account-number")?.capacity).toBe(12);
  });

  it("6. labels the name field", () => {
    expect(nodeById(initial, "textbox:name-search")?.name).toBe("Name Search");
  });

  it("7. reads the name field's capacity as 28 cells", () => {
    // 28 cells wide and still a FIELD, not a list row. Width alone cannot tell those apart; the
    // structural rule (a list row has no label to its left) is what gets this right.
    expect(nodeById(initial, "textbox:name-search")?.capacity).toBe(28);
  });
});

describe("focus follows the hardware cursor - the only focus signal a VT screen has", () => {
  it("8. starts focus on the account field", () => {
    expect(nodeById(initial, "textbox:account-number")?.state.focused).toBe(true);
  });

  it("9. does not report the name field as focused", () => {
    expect(nodeById(initial, "textbox:name-search")?.state.focused).toBe(false);
  });

  it("10. moves focus to the name field after TAB", () => {
    expect(nodeById(tabbed, "textbox:name-search")?.state.focused).toBe(true);
  });

  it("11. takes focus off the account field after TAB", () => {
    expect(nodeById(tabbed, "textbox:account-number")?.state.focused).toBe(false);
  });

  it("12. reads a typed value back out of the field", () => {
    expect(nodeById(typed, "textbox:account-number")?.value).toBe("12345");
  });
});

describe("the function-key legend becomes activatable controls", () => {
  it("13. finds three controls on the inquiry screen", () => {
    expect(nodesByRole(initial, "button")).toHaveLength(3);
  });

  it("14. binds Exit to F3 at this tenant", () => {
    expect(nodeById(initial, "button:exit")?.key).toBe("F3");
  });

  it("15. binds Search to ENTER", () => {
    expect(nodeById(initial, "button:search")?.key).toBe("ENTER");
  });

  it("16. binds Open Suffix to ENTER on the detail screen", () => {
    expect(nodeById(detail, "button:open-suffix")?.key).toBe("ENTER");
  });
});

describe("the account block: columns from the data, selection from reverse video", () => {
  it("17. finds exactly one list on the detail screen", () => {
    expect(nodesByRole(detail, "list")).toHaveLength(1);
  });

  it("18. finds its three rows", () => {
    expect(nodesByRole(detail, "list")[0]?.children).toHaveLength(3);
  });

  it("19. names the columns from the header row", () => {
    expect(nodesByRole(detail, "list")[0]?.columns).toEqual(["SUFFIX", "DESCRIPTION", "BALANCE"]);
  });

  it("20. reports row 0 as selected initially", () => {
    expect(nodesByRole(detail, "list")[0]?.children?.[0]?.state.selected).toBe(true);
  });

  it("21. does not truncate a right-aligned balance", () => {
    // The bug this assertion exists for: slicing by the HEADER's width gives "1,2", because a
    // right-aligned numeric column overflows its header. Gutter detection over the data gives the
    // whole number. On an account list a truncated balance is a wrong number read to a member.
    expect(nodesByRole(detail, "list")[0]?.children?.[0]?.cells?.BALANCE).toBe("1,204.55");
  });

  it("22. moves the selection to row 2 after two cursor-downs", () => {
    expect(nodesByRole(arrowed, "list")[0]?.children?.[2]?.state.selected).toBe(true);
  });

  it("23. reads the selected row's suffix as D0001", () => {
    const rows = nodesByRole(arrowed, "list")[0]?.children ?? [];
    expect(rows.find((row) => row.state.selected)?.cells?.SUFFIX).toBe("D0001");
  });
});

describe("read-only values printed in plain text", () => {
  it("24. reads the member id as a labelled text node", () => {
    expect(nodeById(detail, "text:member")?.value).toBe("12345");
  });
});

describe("the status band is REPORTED, never interpreted (driver rule D9)", () => {
  it("25. reports the not-found banner verbatim", () => {
    expect(nodesByRole(notfound, "status")[0]?.value).toBe("*** NO MEMBER ON FILE FOR 77777");
  });

  it("26. reports the permission-denial banner verbatim", () => {
    expect(nodesByRole(denied, "status")[0]?.value).toBe(
      "*** SECURITY VIOLATION - TELLER NOT AUTHORIZED",
    );
  });

  it("27. reports the validation banner verbatim", () => {
    expect(nodesByRole(invalid, "status")[0]?.value).toBe(
      "*** INVALID ACCOUNT NUMBER - NUMERIC ONLY",
    );
  });

  it("28. emits no status node on the happy path", () => {
    expect(nodesByRole(initial, "status")).toHaveLength(0);
  });

  it("29. assigns the status band no meaning", () => {
    // The whole point. Three screens above carry a business outcome, a permission denial and a
    // validation error, and the detector calls all three `status` with `name: null`. Deciding that
    // the first one means MEMBER_NOT_FOUND belongs to the artifact's DECLARED outcome detector,
    // where it can be reviewed, versioned and overridden per tenant. A driver that classified it
    // would have put the error taxonomy in the one place it can never be audited.
    expect(nodesByRole(notfound, "status")[0]?.name).toBeNull();
    expect(nodesByRole(denied, "status")[0]?.name).toBeNull();
    expect(nodesByRole(invalid, "status")[0]?.name).toBeNull();
  });
});

describe("ids are name-derived, never coordinate-derived (driver rule D10)", () => {
  it("30. puts no row/column pair in any id", () => {
    // A grid coordinate is this surface's CSS selector, and BRIEF section 3.7 forbids storing one.
    // Coordinates survive in `bounds`, where they are only ever the lowest-ranked descriptor.
    for (const node of detail.nodes) expect(node.id).not.toMatch(/\d+[,x]\d+/);
  });

  it("31. keeps an id stable when the field's value changes", () => {
    expect(nodeById(typed, "textbox:account-number")).toBeDefined();
    expect(nodeById(notfound, "textbox:account-number")).toBeDefined();
    expect(nodeById(initial, "textbox:account-number")).toBeDefined();
  });
});
