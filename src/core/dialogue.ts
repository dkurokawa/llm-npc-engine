/**
 * Everything that changes turn to turn as the player talks: conversation
 * history per NPC, and the moment a turn's outcome gets written into
 * `GameState`.
 *
 * The one rule that matters here: a backend call that throws must leave
 * nothing behind. The player can just try the line (or the confrontation)
 * again, and it has to land on exactly the situation the failed attempt saw
 * — otherwise a network hiccup silently erases the fact that a lie just broke.
 */

import { brokenLieDirective, buildNpcPrompt } from "./prompt.ts";
import type { GameState } from "./state.ts";
import type { EvidenceId, FactId, Lie, Npc, NpcId } from "./types.ts";
import type { ChatMessage, LlmBackend } from "../llm/index.ts";

export interface SayResult {
  reply: string;
  /** Facts newly established by this turn, in the order `GameState.recordTurn` found them. */
  granted: FactId[];
}

/**
 * The outcome of `Dialogue.confront`. `broken: false` means the evidence
 * didn't break anything — the backend was never called, so there's no reply.
 */
export type ConfrontResult =
  | { broken: false }
  | { broken: true; lie: Lie; reply: string; granted: FactId[] };

export class Dialogue {
  readonly #state: GameState;
  readonly #backend: LlmBackend;
  /** Conversation history per NPC, so each remembers its own thread. */
  readonly #histories = new Map<NpcId, ChatMessage[]>();

  constructor(state: GameState, backend: LlmBackend) {
    this.#state = state;
    this.#backend = backend;
  }

  /**
   * Sends the player's line to `npcId` and returns the reply.
   *
   * On failure, the backend's error is rethrown as-is and nothing changes —
   * not the history, not `state`. A retry of the same line sees exactly the
   * situation the failed attempt saw.
   */
  async say(npcId: NpcId, playerLine: string): Promise<SayResult> {
    const npc = this.#npc(npcId);
    const { system } = buildNpcPrompt(this.#state, npcId, npc, playerLine);

    const history = this.#histories.get(npcId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: playerLine },
    ];

    const res = await this.#backend.chat(messages);
    const reply = res.content || "……";

    // Nothing below this line may throw: everything up to here can be
    // retried untouched, but this is the point of no return for the turn.
    history.push({ role: "user", content: playerLine });
    history.push({ role: "assistant", content: reply });
    this.#histories.set(npcId, history);

    const granted = this.#state.recordTurn(npcId, npc, playerLine);
    return { reply, granted };
  }

  /**
   * Presents `evidenceId` to `npcId`. If it doesn't break any of their active
   * lies, the backend is never called and nothing changes — there's nothing
   * for the model to react to. If it does, the model is asked to react
   * *before* anything commits: `GameState.present()` (which marks the lie
   * broken and grants its facts) and the history append both happen only
   * once the backend has actually answered, so a failed call leaves the lie
   * standing, exactly as if `/show` had never been tried.
   */
  async confront(
    npcId: NpcId,
    evidenceId: EvidenceId,
    playerLine: string,
  ): Promise<ConfrontResult> {
    const npc = this.#npc(npcId);
    const lie = this.#state.findBreakingLie(npcId, evidenceId);
    if (!lie) return { broken: false };

    const { system } = buildNpcPrompt(this.#state, npcId, npc, playerLine);
    const directive = brokenLieDirective(lie);

    const history = this.#histories.get(npcId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: `${system}\n\n${directive}` },
      ...history,
      { role: "user", content: playerLine },
    ];

    const res = await this.#backend.chat(messages);
    const reply = res.content || "……";

    // Nothing below this line may throw: only a successful reply commits the
    // confrontation, so a failed call leaves the lie standing for a retry.
    const presentGranted = this.#state.present(npcId, evidenceId).granted;
    const turnGranted = this.#state.recordTurn(npcId, npc, playerLine);

    history.push({ role: "user", content: playerLine });
    history.push({ role: "assistant", content: reply });
    this.#histories.set(npcId, history);

    return { broken: true, lie, reply, granted: [...presentGranted, ...turnGranted] };
  }

  #npc(npcId: NpcId): Npc {
    const npc = this.#state.scenario.npcs[npcId];
    if (!npc) throw new Error(`no such npc: ${npcId}`);
    return npc;
  }
}
