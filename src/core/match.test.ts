import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { matchesAny } from "./match.ts";

describe("matchesAny", () => {
  test("matches a plain substring", () => {
    assert.equal(matchesAny("マントの男を見た", ["マント"]), true);
  });

  test("does not match when no keyword is a substring", () => {
    assert.equal(matchesAny("今日はいい天気ですね", ["マント", "受取証"]), false);
  });

  test("is case-insensitive", () => {
    assert.equal(matchesAny("the CLOAK was black", ["cloak"]), true);
  });

  test("folds full-width alphanumerics to half-width before comparing", () => {
    assert.equal(matchesAny("部屋は３号室だった", ["3号室"]), true);
  });

  test("an empty keyword list never matches, even an empty line", () => {
    assert.equal(matchesAny("", []), false);
    assert.equal(matchesAny("なんでも", []), false);
  });

  test("any one of several keywords matching is enough", () => {
    assert.equal(matchesAny("借金の話です", ["昨夜", "借", "アリバイ"]), true);
  });
});
