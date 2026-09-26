import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { brokenLieDirective } from "./prompt.ts";
import type { Lie } from "./types.ts";

const SAMPLE_LIE: Lie = {
  id: "alibi_lie",
  topic: "昨夜どこにいたか",
  claim: "ずっと店にいた",
  truth: "外出していた",
  keywords: ["昨夜"],
  broken_by: ["receipt"],
  on_broken: { reaction: "動揺して口ごもる", grants: ["martha_confessed"] },
};

describe("brokenLieDirective", () => {
  test("includes the claim, the truth, and the reaction to perform", () => {
    const directive = brokenLieDirective(SAMPLE_LIE);
    assert.ok(directive.includes(SAMPLE_LIE.claim), "the claim being retracted should be named");
    assert.ok(directive.includes(SAMPLE_LIE.truth), "the truth it's replaced by should be named");
    assert.ok(
      directive.includes(SAMPLE_LIE.on_broken.reaction),
      "the stage direction for how to react should be included",
    );
  });
});
