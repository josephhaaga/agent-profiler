import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp, sum, truncate, groupBy, formatDuration, deepMerge } from "./index.js";

describe("clamp", () => {
  it("returns min when below range", () => assert.equal(clamp(0, 1, 10), 1));
  it("returns max when above range", () => assert.equal(clamp(20, 1, 10), 10));
  it("returns value when in range", () => assert.equal(clamp(5, 1, 10), 5));
  it("returns max when equal to max", () => assert.equal(clamp(10, 1, 10), 10)); // fails with bug
});

describe("sum", () => {
  it("sums a list", () => assert.equal(sum([1, 2, 3]), 6));
  it("returns 0 for empty array", () => assert.equal(sum([]), 0)); // fails with bug
});

describe("truncate", () => {
  it("leaves short strings alone", () => assert.equal(truncate("hi", 10), "hi"));
  it("truncates long strings", () => assert.equal(truncate("hello world", 5), "hello..."));
});

describe("groupBy", () => {
  it("groups by key", () => {
    const result = groupBy([{ type: "a" }, { type: "b" }, { type: "a" }], "type");
    assert.equal(result["a"]!.length, 2);
    assert.equal(result["b"]!.length, 1);
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => assert.equal(formatDuration(90_000), "1m 30s")); // fails (TODO)
  it("formats hours", () => assert.equal(formatDuration(3_661_000), "1h 1m 1s")); // fails (TODO)
});

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3 });
    assert.deepEqual(result, { a: 1, b: 3 });
  });
  it("merges nested objects", () => {
    const result = deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } });
    assert.deepEqual(result, { a: { x: 1, y: 3 } });
  });
});
