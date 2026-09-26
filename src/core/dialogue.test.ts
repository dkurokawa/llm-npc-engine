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

  test("a failed call changes nothing, and a retry still carries the pending directive", async () => {
    const state = new GameState(sample);
    const martha = sample.npcs.martha!;
    // Set up a broken lie the way play.ts's /show handler does, so a
    // directive is pending before the backend call under test happens.
    state.recordTurn("martha", martha, "昨夜はどこにいましたか？");
    const broken = state.present("martha", "receipt");
    assert.equal(broken.broken, true);

    const backend = new FakeBackend(new Error("network down"), "観念して認めるよ");
    const dialogue = new Dialogue(state, backend);
    dialogue.setDirective("martha", "動揺した様子で応じること");

    const factsBeforeFailure = state.facts.slice().sort();
    await assert.rejects(() => dialogue.say("martha", "本当のことを話せ"), /network down/);
    assert.deepEqual(state.facts.slice().sort(), factsBeforeFailure, "a failed turn must not change state");

    // Retry with the same line: the directive set before the failure is
    // still there for the backend to see.
    const result = await dialogue.say("martha", "本当のことを話せ");
    assert.equal(result.reply, "観念して認めるよ");

    const retryMessages = backend.calls[1]!;
    const system = retryMessages[0]!;
    assert.equal(system.role, "system");
    assert.ok(system.content.includes("動揺した様子で応じること"));
  });

  test("a directive is consumed by the reply it decorates, and not repeated after", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend("わかった、話す", "それだけだ");
    const dialogue = new Dialogue(state, backend);
    dialogue.setDirective("gareth", "焦った様子で答えること");

    await dialogue.say("gareth", "本当のことを言え");
    const firstSystem = backend.calls[0]![0]!;
    assert.ok(firstSystem.content.includes("焦った様子で答えること"));

    await dialogue.say("gareth", "続けて");
    const secondSystem = backend.calls[1]![0]!;
    assert.ok(
      !secondSystem.content.includes("焦った様子で答えること"),
      "a directive should not survive past the reply it was set for",
    );
  });

  test("say() throws for an unknown NPC id without touching the backend", async () => {
    const state = new GameState(sample);
    const backend = new FakeBackend();
    const dialogue = new Dialogue(state, backend);

    await assert.rejects(() => dialogue.say("nobody", "hello"), /no such npc: nobody/);
    assert.deepEqual(backend.calls, []);
  });
});
