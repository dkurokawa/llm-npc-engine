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

import { loadScenario, validateScenario } from "./load.ts";
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

/** Plays the sample scenario up to the point where the accusation unlocks. */
function playToUnlock(state: GameState): void {
  const gareth = sample.npcs.gareth!;
  const martha = sample.npcs.martha!;

  state.recordDisclosure(gareth); // saw_cloak
  state.recordDisclosure(gareth); // knows_departure
  state.recordDisclosure(gareth); // found_receipt

  state.recordLiesTold("martha", state.activeLies("martha", martha));
  state.present("martha", "receipt"); // martha_confessed

  state.recordDisclosure(gareth); // knows_debt
}

describe("scenario loading", () => {
  test("the sample scenario is valid", () => {
    assert.deepEqual(validateScenario(sample.world, sample.npcs), []);
  });

  test("a dangling fact reference is reported", () => {
    const problems = validateScenario(
      { ...sample.world, solutions: [{ ...sample.world.solutions[0]!, requires: ["nope"] }] },
      sample.npcs,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /unknown fact "nope"/);
  });

  test("an answer outside its own options is reported", () => {
    const solution = sample.world.solutions[0]!;
    const problems = validateScenario(
      {
        ...sample.world,
        solutions: [
          {
            ...solution,
            slots: [{ ...solution.slots[0]!, answer: "nobody" }, ...solution.slots.slice(1)],
          },
        ],
      },
      sample.npcs,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /not among its options/);
  });
});

describe("knowledge disclosure", () => {
  test("gated knowledge stays out of the prompt until it is unlocked", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;

    const before = buildNpcPrompt(state, "gareth", gareth).system;
    assert.ok(!before.includes("明け方"), "locked knowledge leaked into the prompt");

    state.recordDisclosure(gareth); // grants saw_cloak
    const after = buildNpcPrompt(state, "gareth", gareth).system;
    assert.ok(after.includes("明け方"), "unlocked knowledge never appeared");
  });

  test("what an NPC must not invent is stated in the prompt", () => {
    const prompt = buildNpcPrompt(fresh(), "gareth", sample.npcs.gareth!).system;
    assert.ok(prompt.includes("黒いマントの男の名前"));
    assert.ok(prompt.includes("推測で答えたり"));
  });

  test("disclosure is idempotent", () => {
    const state = fresh();
    const gareth = sample.npcs.gareth!;
    state.recordDisclosure(gareth);
    const granted = state.recordDisclosure(gareth);
    assert.deepEqual(granted, ["knows_departure"], "should only grant the newly unlocked fact");
  });
});

describe("lies", () => {
  test("a lie is told as fact, and its truth is never sent to the model", () => {
    const state = fresh();
    const prompt = buildNpcPrompt(state, "martha", sample.npcs.martha!).system;
    assert.ok(prompt.includes("ずっと店にいて"), "the claim should be present");
    assert.ok(!prompt.includes("雨の中を出かけていて"), "the truth must never be sent");
    assert.ok(!prompt.includes("嘘"), "the model must not be told it is lying");
  });

  test("evidence breaks the matching lie and grants its facts", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordLiesTold("martha", state.activeLies("martha", martha));

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
    state.recordLiesTold("martha", state.activeLies("martha", martha));
    state.present("martha", "receipt");

    assert.deepEqual(state.activeLies("martha", martha), []);
    const prompt = buildNpcPrompt(state, "martha", martha).system;
    assert.ok(!prompt.includes("ずっと店にいて"), "the broken lie was offered again");
  });

  test("the wrong evidence changes nothing", () => {
    const state = fresh();
    const martha = sample.npcs.martha!;
    state.recordLiesTold("martha", state.activeLies("martha", martha));

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

  test("it will not even be scored while its requirements are unmet", () => {
    const state = fresh();
    const verdict = state.accuse({ solutionId: "case_closed", answers: correct });

    assert.equal(verdict.kind, "locked");
    assert.deepEqual(
      verdict.kind === "locked" ? verdict.missing : [],
      ["martha_confessed", "knows_debt"],
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
    assert.deepEqual(
      verdict.kind === "incomplete" ? verdict.missing : [],
      ["method", "motive"],
    );
  });

  test("every slot correct at once closes the case", () => {
    const state = fresh();
    playToUnlock(state);

    const verdict = state.accuse({ solutionId: "case_closed", answers: correct });
    assert.equal(verdict.kind, "solved");
    assert.equal(state.isSolved("case_closed"), true);
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
