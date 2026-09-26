/**
 * The progression rules, tested without an LLM anywhere in sight.
 *
 * That these run offline and deterministically is the point of the design: if
 * the model decided when the case was solved, none of this could be asserted.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

import { loadScenario } from "./load.ts";
import { buildNpcPrompt } from "./prompt.ts";
import { GameState } from "./state.ts";
import type { Scenario } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(here, "..", "..", "scenarios", "sample");

let sample: Scenario;
before(async () => {
  sample = await loadScenario(SAMPLE_DIR);
});

const fresh = () => new GameState(sample);

// Lines chosen to match exactly one keyword-gated entry each, in the order a
// player would actually have to ask them (each depends on the last).
const ASK_ABOUT_CLOAK = "昨夜、怪しい客が泊まっていましたか？"; // gareth.cloak_man_stayed
const ASK_WHEN_LEFT = "その男はいつ出て行ったのですか？"; // gareth.left_at_dawn
const ASK_ABOUT_ROOM = "部屋に何か残っていませんでしたか？"; // gareth.receipt_in_room
const ASK_ABOUT_DEBT_RUMOR = "マーサが借金をしていたという噂は本当ですか？"; // gareth.martha_owed_money
const ASK_ALIBI = "昨夜はどこにいましたか？"; // martha.alibi_lie
const UNRELATED = "今日はいい天気ですね";

/** Plays the sample scenario up to the point where the accusation unlocks. */
function playToUnlock(state: GameState): void {
  const gareth = sample.npcs.gareth!;
  const martha = sample.npcs.martha!;

  state.recordTurn("gareth", gareth, ASK_ABOUT_CLOAK); // saw_cloak
  state.recordTurn("gareth", gareth, ASK_WHEN_LEFT); // knows_departure
  state.recordTurn("gareth", gareth, ASK_ABOUT_ROOM); // found_receipt

  state.recordTurn("martha", martha, ASK_ALIBI); // heard_alibi (lie told)
  state.present("martha", "receipt"); // martha_confessed

  state.recordTurn("gareth", gareth, ASK_ABOUT_DEBT_RUMOR); // knows_debt
}

describe("knowledge disclosure", () => {
  test("background knowledge (no keywords) is always in the prompt once `requires` holds", () => {
    const prompt = buildNpcPrompt(fresh(), "martha", sample.npcs.martha!, UNRELATED).system;
    assert.ok(prompt.includes("常連"), "background knowledge should need no matching line");
  });

  test("an unrelated line neither discloses keyworded knowledge nor grants its fact", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;

    const prompt = buildNpcPrompt(state, "gareth", gareth, UNRELATED).system;
    assert.ok(!prompt.includes("着た男"), "keyworded knowledge appeared without a matching line");

    const granted = state.recordTurn("gareth", gareth, UNRELATED);
    assert.deepEqual(granted, []);
  });

  test("a matching line reveals the knowledge in that same turn's prompt", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;

    const prompt = buildNpcPrompt(state, "gareth", gareth, ASK_ABOUT_CLOAK).system;
    assert.ok(prompt.includes("着た男"), "a matching line should unlock the knowledge immediately");
  });

  test("a matching line grants the fact once recorded", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;

    const granted = state.recordTurn("gareth", gareth, ASK_ABOUT_CLOAK);
    assert.deepEqual(granted, ["saw_cloak"]);
    assert.equal(state.has("saw_cloak"), true);
  });

  test("once disclosed, knowledge stays in the prompt no matter what is said next", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;
    state.recordTurn("gareth", gareth, ASK_ABOUT_CLOAK);

    const prompt = buildNpcPrompt(state, "gareth", gareth, UNRELATED).system;
    assert.ok(prompt.includes("着た男"), "an NPC forgot something it already said");
  });

  test("recording the same matching line twice grants the fact only once", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;
    state.recordTurn("gareth", gareth, ASK_ABOUT_CLOAK);
    const granted = state.recordTurn("gareth", gareth, ASK_ABOUT_CLOAK);
    assert.deepEqual(granted, []);
  });

  test("a gated knowledge entry stays hidden until its own `requires` holds, even if asked about early", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;
    // left_at_dawn requires saw_cloak, which has not been granted yet.
    const granted = state.recordTurn("gareth", gareth, ASK_WHEN_LEFT);
    assert.deepEqual(granted, []);
    assert.equal(state.has("knows_departure"), false);
  });

  test("what an NPC must not invent is stated in the prompt", () => {
    const prompt = buildNpcPrompt(fresh(), "gareth", sample.npcs.gareth!, UNRELATED).system;
    assert.ok(prompt.includes("黒いマントの男の名前"));
    assert.ok(prompt.includes("推測で答えたり"));
  });
});

describe("lies", () => {
  test("a lie is told as fact, and its truth is never sent to the model", () => {
    const state = fresh();
    const prompt = buildNpcPrompt(state, "martha", sample.npcs.martha!, UNRELATED).system;
    assert.ok(prompt.includes("ずっと店にいて"), "the claim should be present");
    assert.ok(!prompt.includes("雨の中を出かけていて"), "the truth must never be sent");
    assert.ok(!prompt.includes("嘘"), "the model must not be told it is lying");
  });

  test("an unrelated line does not count as having told the lie", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordTurn("martha", martha, UNRELATED);

    const verdict = state.present("martha", "receipt");
    assert.equal(verdict.broken, false, "evidence resolved a lie that was never asked about");
    assert.equal(state.has("heard_alibi"), false);
  });

  test("a matching line counts as having told the lie, and grants its fact", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    const granted = state.recordTurn("martha", martha, ASK_ALIBI);
    assert.deepEqual(granted, ["heard_alibi"]);
  });

  test("evidence breaks a lie that has been told, and grants its facts", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordTurn("martha", martha, ASK_ALIBI);

    const verdict = state.present("martha", "receipt");
    assert.equal(verdict.broken, true);
    assert.equal(verdict.lie?.id, "alibi_lie");
    assert.deepEqual(verdict.granted, ["martha_confessed"]);
  });

  test("a lie cannot be broken before the player has heard it", () => {
    const state = fresh();
    const verdict = state.present("martha", "receipt");
    assert.equal(verdict.broken, false, "evidence resolved a contradiction never established");
    assert.equal(state.has("martha_confessed"), false);
  });

  test("a broken lie is not repeated", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordTurn("martha", martha, ASK_ALIBI);
    state.present("martha", "receipt");

    assert.deepEqual(state.activeLies("martha", martha), []);
    const prompt = buildNpcPrompt(state, "martha", martha, UNRELATED).system;
    assert.ok(!prompt.includes("ずっと店にいて"), "the broken lie was offered again");
  });

  test("the wrong evidence changes nothing", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordTurn("martha", martha, ASK_ALIBI);

    const verdict = state.present("martha", "no_such_item");
    assert.equal(verdict.broken, false);
    assert.deepEqual(verdict.granted, []);
    assert.equal(state.activeLies("martha", martha).length, 1);
  });
});

describe("evidence inventory", () => {
  test("evidence is held only once the facts behind it hold", () => {
    const state = fresh();
    assert.equal(state.holds("receipt"), false);

    state.grant(["found_receipt"]);
    assert.equal(state.holds("receipt"), true);
    assert.deepEqual(state.heldEvidence(), ["receipt"]);
  });
});

describe("accusation — the multi-condition lock", () => {
  const correct = { culprit: "martha", method: "lured_out", motive: "debt" };

  test("attemptableSolutions is empty while its requirements are unmet", () => {
    const state = fresh();
    assert.deepEqual(state.attemptableSolutions(), []);

    const verdict = state.accuse({ solutionId: "case_closed", answers: correct });
    assert.equal(verdict.kind, "locked");
    assert.deepEqual(verdict.missing, ["martha_confessed", "knows_debt"]);
  });

  test("attemptableSolutions offers it once its requirements hold", () => {
    const state = fresh();
    playToUnlock(state);
    assert.deepEqual(
      state.attemptableSolutions().map((s) => s.id),
      ["case_closed"],
    );
  });

  test("a partly filled accusation is not scored", () => {
    const state = fresh();
    playToUnlock(state);

    const verdict = state.accuse({
      solutionId: "case_closed",
      answers: { culprit: "martha" },
    });
    assert.equal(verdict.kind, "incomplete");
    assert.deepEqual(verdict.missing, ["method", "motive"]);
  });

  test("every slot correct at once closes the case", () => {
    const state = fresh();
    playToUnlock(state);

    const verdict = state.accuse({ solutionId: "case_closed", answers: correct });
    assert.equal(verdict.kind, "solved");
    assert.equal(state.isSolved("case_closed"), true);
    assert.deepEqual(state.attemptableSolutions(), [], "a solved case is no longer attemptable");
  });

  test("two of three correct is simply wrong", () => {
    const state = fresh();
    playToUnlock(state);

    const verdict = state.accuse({
      solutionId: "case_closed",
      answers: { ...correct, motive: "revenge" },
    });
    assert.equal(verdict.kind, "wrong");
    assert.equal(state.isSolved("case_closed"), false);
  });

  test("a wrong verdict reveals nothing about which slots were right", () => {
    const state = fresh();
    playToUnlock(state);

    // One slot right vs. none right must be indistinguishable, or the player
    // can solve each slot separately: 3+3+3 tries instead of 27.
    const oneRight = state.accuse({
      solutionId: "case_closed",
      answers: { culprit: "martha", method: "broke_in", motive: "revenge" },
    });
    const noneRight = state.accuse({
      solutionId: "case_closed",
      answers: { culprit: "gareth", method: "broke_in", motive: "revenge" },
    });
    assert.deepEqual(oneRight, noneRight);
  });

  test("no single lucky guess gets through the lock", () => {
    const solution = sample.world.solutions[0]!;
    const state = fresh();
    playToUnlock(state);

    // Exhaustively: every combination differing from the answer in any slot
    // must be rejected. Only the one fully correct set may pass.
    let solved = 0;
    const [a, b, c] = solution.slots;
    for (const x of a!.options) {
      for (const y of b!.options) {
        for (const z of c!.options) {
          const attempt = new GameState(sample);
          playToUnlock(attempt);
          const verdict = attempt.accuse({
            solutionId: "case_closed",
            answers: { [a!.id]: x, [b!.id]: y, [c!.id]: z },
          });
          if (verdict.kind === "solved") solved += 1;
        }
      }
    }
    assert.equal(solved, 1, "exactly one of the 27 combinations may be accepted");
  });
});
