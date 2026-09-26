/**
 * Everything that changes turn to turn as the player talks: conversation
 * history per NPC, a pending stage direction left by a broken lie, and the
 * moment a turn's outcome gets written into `GameState`.
 *
 * The one rule that matters here: a backend call that throws must leave
 * nothing behind. The player can just try the line again, and a directive
 * set right before the failure has to survive to be used on that retry —
 * otherwise a network hiccup silently erases the fact that a lie just broke.
 */

import { buildNpcPrompt } from "./prompt.ts";
import type { GameState } from "./state.ts";
import type { FactId, Npc, NpcId } from "./types.ts";
import type { ChatMessage, LlmBackend } from "../llm/index.ts";

export interface SayResult {
  reply: string;
  /** Facts newly established by this turn, in the order `GameState.recordTurn` found them. */
  granted: FactId[];
}

export class Dialogue {
  readonly #state: GameState;
  readonly #backend: LlmBackend;
  /** Conversation history per NPC, so each remembers its own thread. */
  readonly #histories = new Map<NpcId, ChatMessage[]>();
  /** A stage direction to attach to the next reply, set when a lie breaks. */
  readonly #directives = new Map<NpcId, string>();

  constructor(state: GameState, backend: LlmBackend) {
    this.#state = state;
    this.#backend = backend;
  }

  /** Queues a stage direction for the next reply from this NPC, e.g. after `/show` breaks a lie. */
  setDirective(npcId: NpcId, text: string): void {
    this.#directives.set(npcId, text);
  }

  /**
   * Sends the player's line to `npcId` and returns the reply.
   *
   * On failure, the backend's error is rethrown as-is and nothing changes —
   * not the history, not the pending directive, not `state`. A retry of the
   * same line sees exactly the situation the failed attempt saw.
   */
  async say(npcId: NpcId, playerLine: string): Promise<SayResult> {
    const npc = this.#npc(npcId);
    const { system } = buildNpcPrompt(this.#state, npcId, npc, playerLine);
    const directive = this.#directives.get(npcId);

    const history = this.#histories.get(npcId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: directive ? `${system}\n\n${directive}` : system },
      ...history,
      { role: "user", content: playerLine },
    ];

    const res = await this.#backend.chat(messages);
    const reply = res.content || "……";

    // Nothing below this line may throw: everything up to here can be
    // retried untouched, but this is the point of no return for the turn.
    this.#directives.delete(npcId);

    history.push({ role: "user", content: playerLine });
    history.push({ role: "assistant", content: reply });
    this.#histories.set(npcId, history);

    const granted = this.#state.recordTurn(npcId, npc, playerLine);
    return { reply, granted };
  }

  #npc(npcId: NpcId): Npc {
    const npc = this.#state.scenario.npcs[npcId];
    if (!npc) throw new Error(`no such npc: ${npcId}`);
    return npc;
  }
}
