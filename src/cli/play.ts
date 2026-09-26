#!/usr/bin/env node
/**
 * A terminal front end for the engine.
 *
 * Deliberately thin: it reads a line, hands it to a `Dialogue`, and prints
 * whatever comes back. Every decision that matters — what an NPC may say,
 * whether a lie falls, whether the case is closed — happens in `src/core/`,
 * so a browser front end can replace this file without touching any of it.
 *
 *   pnpm play [scenario-dir]
 */

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Dialogue } from "../core/dialogue.ts";
import { loadScenario, ScenarioError } from "../core/load.ts";
import { brokenLieDirective } from "../core/prompt.ts";
import { GameState } from "../core/state.ts";
import type { NpcId, Scenario, Solution } from "../core/types.ts";
import { backendFromEnv } from "../llm/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO = path.join(here, "..", "..", "scenarios", "sample");

const HELP = `
  /who              いま話せる相手を出す
  /talk <id>        相手を変える
  /notes            分かっていること・持ち物を出す
  /show <evidence>  いまの相手に証拠を突きつける
  /accuse           推理を突きつける
  /help             この一覧
  /quit             やめる
`.trimEnd();

async function main(): Promise<void> {
  const scenarioDir = process.argv[2] ?? DEFAULT_SCENARIO;

  let scenario: Scenario;
  try {
    scenario = await loadScenario(scenarioDir);
  } catch (err) {
    if (err instanceof ScenarioError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const state = new GameState(scenario);
  const backend = backendFromEnv();
  const dialogue = new Dialogue(state, backend);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Consumed as an async iterator rather than through rl.question(): with
  // piped input the stream ends while the first question is still awaited, and
  // question() would then drop every remaining buffered line. Iterating keeps
  // scripted playthroughs (demo recordings, smoke runs) intact.
  // readline's own typing leaves `TReturn` at its `any` default, which would
  // otherwise leak into the `{ value, done }` destructure below; the cast
  // pins it to `void`, which is what a finished iterator actually returns.
  const lines = rl[Symbol.asyncIterator]() as NodeJS.AsyncIterator<string, void>;

  const npcIds = Object.keys(scenario.npcs);
  let current: NpcId = npcIds[0]!;

  const npcName = (id: NpcId) => scenario.npcs[id]?.name ?? id;

  const announceFacts = (granted: string[]) => {
    for (const f of granted) {
      const label = scenario.world.facts[f]?.label ?? f;
      console.log(`  * 分かったこと: ${label}`);
    }
  };

  console.log(`\n=== ${scenario.world.title} ===`);
  console.log(scenario.world.synopsis);
  console.log(`\n[${backend.label}]  /help でコマンド一覧\n`);
  console.log(`── ${npcName(current)} と話している ──`);

  /** Returns null once input is exhausted, so piped scripts end cleanly. */
  const prompt = async (q: string): Promise<string | null> => {
    process.stdout.write(q);
    const { value, done } = await lines.next();
    if (done) {
      process.stdout.write("\n");
      return null;
    }
    return value;
  };

  for (;;) {
    const raw = await prompt(`\n> `);
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    // --- commands ---------------------------------------------------------
    if (line === "/quit") break;

    if (line === "/help") {
      console.log(HELP);
      continue;
    }

    if (line === "/who") {
      for (const id of npcIds) {
        const mark = id === current ? "*" : " ";
        console.log(` ${mark} ${id.padEnd(10)} ${npcName(id)}（${scenario.npcs[id]!.role}）`);
      }
      continue;
    }

    if (line.startsWith("/talk")) {
      const id = line.slice(5).trim();
      if (!scenario.npcs[id]) {
        console.log(`そんな相手はいない: ${id}`);
        continue;
      }
      current = id;
      console.log(`── ${npcName(current)} と話している ──`);
      continue;
    }

    if (line === "/notes") {
      const facts = state.facts;
      console.log(facts.length ? "【分かっていること】" : "【分かっていること】まだ何も。");
      for (const f of facts) console.log(`  - ${scenario.world.facts[f]?.label ?? f}`);

      const held = state.heldEvidence();
      console.log(held.length ? "【持ち物】" : "【持ち物】なし。");
      for (const e of held) {
        const ev = scenario.world.evidence[e]!;
        console.log(`  - ${e}: ${ev.label} — ${ev.description}`);
      }
      continue;
    }

    if (line.startsWith("/show")) {
      const evidenceId = line.slice(5).trim();
      if (!state.holds(evidenceId)) {
        console.log("そんなものは持っていない。/notes で持ち物を確かめる。");
        continue;
      }

      const verdict = state.present(current, evidenceId);
      if (verdict.broken && verdict.lie) {
        // The confrontation resolved in code; the model is only told how to
        // act now that it has, never asked to judge the contradiction itself.
        dialogue.setDirective(current, brokenLieDirective(verdict.lie));
        console.log(`  ${scenario.world.evidence[evidenceId]!.label}を突きつけた。`);
        announceFacts(verdict.granted);
        await speak(`これはどういうことだ。${scenario.world.evidence[evidenceId]!.label}がある。`);
      } else {
        console.log("  相手は顔色ひとつ変えなかった。");
      }
      continue;
    }

    if (line === "/accuse") {
      await accuse();
      continue;
    }

    if (line.startsWith("/")) {
      console.log(`知らないコマンド。/help を見る。`);
      continue;
    }

    await speak(line);
  }

  rl.close();

  // --- talking -------------------------------------------------------------

  async function speak(playerLine: string): Promise<void> {
    let result;
    try {
      result = await dialogue.say(current, playerLine);
    } catch (err) {
      console.error(`  (返事が返ってこなかった: ${(err as Error).message})`);
      return;
    }

    console.log(`\n${npcName(current)}「${result.reply}」`);
    announceFacts(result.granted);
  }

  // --- accusing ------------------------------------------------------------

  async function accuse(): Promise<void> {
    const attemptable = state.attemptableSolutions();
    if (attemptable.length === 0) {
      console.log("まだ確信が持てない。話を聞き込む余地がある。");
      return;
    }

    let solution: Solution;
    if (attemptable.length === 1) {
      solution = attemptable[0]!;
    } else {
      console.log("\nどの事件について問い詰める？");
      attemptable.forEach((s, i) => {
        console.log(`  ${i + 1}) ${s.label}`);
      });
      const pick = await prompt("  番号: ");
      if (pick === null) return;
      const idx = Number(pick.trim()) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= attemptable.length) {
        console.log("……やめておこう。");
        return;
      }
      solution = attemptable[idx]!;
    }

    const answers: Record<string, string> = {};
    for (const slot of solution.slots) {
      console.log(`\n${slot.question}?`);
      slot.options.forEach((o, i) => {
        console.log(`  ${i + 1}) ${o}`);
      });
      const pick = await prompt("  番号: ");
      if (pick === null) return;
      const idx = Number(pick.trim()) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= slot.options.length) {
        console.log("……やめておこう。");
        return;
      }
      answers[slot.id] = slot.options[idx]!;
    }

    const verdict = state.accuse({ solutionId: solution.id, answers });
    if (verdict.kind === "solved") {
      console.log(`\n${verdict.narration}\n\n=== ${solution.label} ===`);
      return;
    }
    // No hint about which slots were right — see docs/schema.md §3.
    console.log("\n違う。誰も口を割らなかった。");
  }
}

await main();
