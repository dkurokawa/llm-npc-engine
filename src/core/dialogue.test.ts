import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

import { Dialogue } from "./dialogue.ts";
import { loadScenario } from "./load.ts";
import { GameState } from "./state.ts";
import type { Scenario } from "./types.ts";
import type { ChatMessage, ChatResult, LlmBackend } from "../llm/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(here, "..", "..", "scenarios", "sample");

let sample: Scenario;
before(async () => {
  sample = await loadScenario(SAMPLE_DIR);
});

/** A scripted backend: replies (or throws) in the order given, and records every call it saw. */
class FakeBackend implements LlmBackend {
  readonly label = "fake";
  readonly calls: ChatMessage[][] = [];
  readonly #script: (string | Error)[];

  constructor(...script: (string | Error)[]) {
    this.#script = script;
  }

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const next = this.#script.shift();
    if (next === undefined) throw new Error("FakeBackend ran out of scripted replies");
    if (next instanceof Error) throw next;
    return { content: next, elapsedMs: 0 };
  }
}

describe("Dialogue", () => {
  test("a successful reply advances history and the facts the line matched", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend("マントの男が泊まったんじゃ", "そのあとすぐ出て行った");
    const dialogue = new Dialogue(state, backend);

    const first = await dialogue.say("gareth", "昨夜、怪しい客が泊まっていましたか？");
    assert.equal(first.reply, "マントの男が泊まったんじゃ");
    assert.deepEqual(first.granted, ["saw_cloak"]);
    assert.equal(state.has("saw_cloak"), true);

    await dialogue.say("gareth", "そのあとは？");
    const secondMessages = backend.calls[1]!;
    assert.ok(
      secondMessages.some(
        (m) => m.role === "assistant" && m.content === "マントの男が泊まったんじゃ",
      ),
      "the first reply should be carried into the second call's history",
    );
  });

  test("an unmatched line advances history but grants nothing", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend("わからんな");
    const dialogue = new Dialogue(state, backend);

    const result = await dialogue.say("gareth", "今日はいい天気ですね");
    assert.deepEqual(result.granted, []);
    assert.deepEqual(state.facts, []);
  });

  test("say() leaves history and facts untouched on failure, and a retry succeeds", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend(new Error("network down"), "マントの男が泊まったんじゃ");
    const dialogue = new Dialogue(state, backend);
    const line = "昨夜、怪しい客が泊まっていましたか？";

    await assert.rejects(() => dialogue.say("gareth", line), /network down/);
    assert.deepEqual(state.facts, [], "a failed turn must not change state");
    assert.equal(backend.calls.length, 1);

    const result = await dialogue.say("gareth", line);
    assert.equal(result.reply, "マントの男が泊まったんじゃ");
    assert.deepEqual(result.granted, ["saw_cloak"]);

    const retryMessages = backend.calls[1]!;
    const userTurns = retryMessages.filter((m) => m.role === "user");
    assert.equal(userTurns.length, 1, "the failed attempt must not have left a stray history entry");
  });

  test("say() throws for an unknown NPC id without touching the backend", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend();
    const dialogue = new Dialogue(state, backend);

    await assert.rejects(() => dialogue.say("nobody", "hello"), /no such npc: nobody/);
    assert.deepEqual(backend.calls, []);
  });
});

describe("Dialogue#confront", () => {
  const CONFRONT_LINE = "これはどういうことだ。雨具の受取証がある。";

  test("never calls the backend when the evidence breaks nothing yet", async () => {
    const state = new GameState(sample);
    // alibi_lie hasn't been told, so present()/findBreakingLie find nothing.
    const backend = new FakeBackend();
    const dialogue = new Dialogue(state, backend);

    const result = await dialogue.confront("martha", "receipt", CONFRONT_LINE);
    assert.deepEqual(result, { broken: false });
    assert.deepEqual(backend.calls, []);
  });

  test("a failed reaction leaves the lie unbroken and ungranted, and a retry breaks it", async () => {
    const state = new GameState(sample);
    const martha = sample.npcs.martha!;
    state.recordTurn("martha", martha, "昨夜はどこにいましたか？"); // tells alibi_lie

    const backend = new FakeBackend(new Error("network down"), "観念して認めるよ");
    const dialogue = new Dialogue(state, backend);

    const factsBeforeFailure = state.facts.slice().sort();
    await assert.rejects(
      () => dialogue.confront("martha", "receipt", CONFRONT_LINE),
      /network down/,
    );
    assert.equal(state.isBroken("martha", "alibi_lie"), false, "the lie must still stand after a failed reaction");
    assert.deepEqual(
      state.facts.slice().sort(),
      factsBeforeFailure,
      "a failed confrontation must not change state",
    );
    assert.equal(backend.calls.length, 1);

    const result = await dialogue.confront("martha", "receipt", CONFRONT_LINE);
    assert.equal(result.broken, true);
    assert.equal(result.reply, "観念して認めるよ");
    assert.equal(result.lie.id, "alibi_lie");
    assert.deepEqual(result.granted, ["martha_confessed"]);
    assert.equal(state.isBroken("martha", "alibi_lie"), true);

    const retryMessages = backend.calls[1]!;
    const userTurns = retryMessages.filter((m) => m.role === "user");
    assert.equal(userTurns.length, 1, "the failed attempt must not have left a stray history entry");
  });
});
