/**
 * Turns the current state into an NPC's system prompt.
 *
 * The important property is what this file leaves out. Knowledge the player has
 * not unlocked is never written into the prompt, so refusing to reveal it is
 * not something the model has to be trusted to do. Likewise a lie's `truth` is
 * never sent: the model states the `claim` believing it, which is what makes
 * the lie sound unrehearsed on an 8B-class model.
 *
 * `playerLine` decides which keyworded knowledge unlocks *this* turn (see
 * `GameState.promptKnowledge`) — the model's own output is never consulted.
 */

import type { GameState } from "./state.ts";
import type { Lie, Npc, NpcId } from "./types.ts";

export interface NpcPrompt {
  system: string;
}

export interface BuildNpcPromptOptions {
  /**
   * Lie ids to leave out of the "what you'll answer" section — for a lie
   * `Dialogue.confront` is about to have the model react to breaking. Without
   * this, the same prompt would both instruct the model to answer with the
   * claim if asked *and*, via `brokenLieDirective`, tell it that claim was
   * just caught as a lie — two contradictory instructions in one system
   * message.
   */
  excludeLieIds?: readonly string[];
}

/** A stage direction appended when evidence has just broken a lie. */
export function brokenLieDirective(lie: Lie): string {
  return [
    `【たった今、嘘が暴かれた】`,
    `あなたは「${lie.claim}」と言っていたが、それは嘘で、本当は「${lie.truth}」だった。`,
    `証拠を突きつけられ、言い逃れはできない。${lie.on_broken.reaction}という様子で応じること。`,
    `もう同じ嘘を繰り返してはいけない。`,
  ].join("\n");
}

export function buildNpcPrompt(
  state: GameState,
  npcId: NpcId,
  npc: Npc,
  playerLine: string,
  options?: BuildNpcPromptOptions,
): NpcPrompt {
  const { world } = state.scenario;
  const lines: string[] = [];

  lines.push(
    `あなたは${world.title}の登場人物「${npc.name}」（${npc.role}）です。`,
    `一人称は「${npc.persona.first_person}」。${npc.persona.speech}`,
  );
  if (npc.persona.extra) lines.push(npc.persona.extra);

  if (world.common_knowledge.length > 0) {
    lines.push("", "【この世界の前提】");
    for (const c of world.common_knowledge) lines.push(`- ${c}`);
  }

  // Only what the player has unlocked, plus whatever this line just asked
  // about. Everything else is simply absent.
  const known = state.promptKnowledge(npcId, npc, playerLine);
  if (known.length > 0) {
    lines.push("", "【あなたが知っていること】");
    for (const k of known) lines.push(`- ${k.content}`);
  }

  // Lies are presented as fact, with no hint that they are lies.
  const lies = state.activeLies(npcId, npc).filter((l) => !options?.excludeLieIds?.includes(l.id));
  if (lies.length > 0) {
    lines.push("", "【あなたが答えること】");
    for (const l of lies) lines.push(`- 「${l.topic}」について聞かれたら「${l.claim}」と答える`);
  }

  if (npc.unknown.length > 0) {
    lines.push("", "【あなたが知らないこと】");
    for (const u of npc.unknown) lines.push(`- ${u}`);
    lines.push(
      "これらを聞かれたら知らないと答えること。推測で答えたり、作り話をしてはいけない。",
    );
  }

  lines.push(
    "",
    "【話し方】",
    "- 一度の返事は2〜3文までにする",
    "- 地の文やト書きを書かず、台詞だけを話す",
    "- 上に書かれていないことを勝手に付け足さない",
  );

  return { system: lines.join("\n") };
}
