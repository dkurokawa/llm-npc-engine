import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { stripThinking } from "./types.ts";

describe("stripThinking", () => {
  test("removes a closed <think> block", () => {
    assert.equal(stripThinking("<think>let me consider</think>hello there"), "hello there");
  });

  test("removes a closed <thinking> block, case-insensitively", () => {
    assert.equal(stripThinking("<THINKING>scratch</THINKING>hello"), "hello");
  });

  test("drops everything from an unterminated block onward", () => {
    assert.equal(stripThinking("hello<think>cut off mid-"), "hello");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(stripThinking("  hello  \n"), "hello");
  });

  test("passes plain text through unchanged", () => {
    assert.equal(stripThinking("hello, nothing to strip"), "hello, nothing to strip");
  });
});
