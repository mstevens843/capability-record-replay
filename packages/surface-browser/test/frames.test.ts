import { describe, expect, it } from "vitest";
import {
  type FrameInfo,
  TOP_FRAME_SEGMENT,
  flattenFrameTree,
  unnamedFrameSegment,
  unperceivableFrameDetail,
} from "../src/frames.js";

const tree = {
  frame: { id: "F0", name: "", url: "http://x/" },
  childFrames: [
    { frame: { id: "F1", name: "banner", url: "http://x/banner" } },
    {
      frame: { id: "F2", name: "content", url: "http://x/search" },
      childFrames: [{ frame: { id: "F3", name: "subacct", url: "http://x/sub" } }],
    },
  ],
};

describe("flattenFrameTree", () => {
  it("names the top document and chains child names beneath it", () => {
    expect(flattenFrameTree(tree).map((frame) => frame.path.join("/"))).toEqual([
      "top",
      "top/banner",
      "top/content",
      "top/content/subacct",
    ]);
  });

  it("is depth first, which is the order the documents appear on screen", () => {
    expect(flattenFrameTree(tree).map((frame) => frame.id)).toEqual(["F0", "F1", "F2", "F3"]);
  });

  it("keeps the raw name beside the segment, so a route can report what the app calls the frame", () => {
    const frames = flattenFrameTree(tree);
    expect(frames[0]?.name).toBe("");
    expect(frames[0]?.path.at(-1)).toBe(TOP_FRAME_SEGMENT);
  });

  it("falls back to an ordinal ONLY for a frame with no author-assigned name", () => {
    const anonymous = {
      frame: { id: "F0", name: "", url: "http://x/" },
      childFrames: [{ frame: { id: "F1", url: "http://x/a" } }],
    };
    expect(flattenFrameTree(anonymous)[1]?.path).toEqual(["top", unnamedFrameSegment(1)]);
  });
});

describe("driver rule D7 - an unreachable frame is reported, never skipped", () => {
  const seen: readonly FrameInfo[] = flattenFrameTree(tree);

  it("says nothing when both views of the page agree", () => {
    expect(unperceivableFrameDetail(seen, ["", "banner", "content", "subacct"])).toBeNull();
  });

  it("reports the frame the page has and this CDP session cannot see", () => {
    const detail = unperceivableFrameDetail(seen, ["", "banner", "content", "subacct", "payments"]);
    expect(detail).toContain("payments");
    expect(detail).toContain("5 frames");
  });

  it("names an unnamed unreachable frame without inventing an identity for it", () => {
    const detail = unperceivableFrameDetail(seen, ["", "banner", "content", "subacct", ""]);
    expect(detail).toContain("<unnamed>");
  });

  it("never puts a url in the detail, because a fault is journalled and a journal is evidence", () => {
    const detail = unperceivableFrameDetail(seen, ["", "banner", "content", "subacct", "x"]);
    expect(detail).not.toContain("http");
  });
});
