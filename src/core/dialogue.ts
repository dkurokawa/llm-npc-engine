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

/**
 * One player's conversation. Turns are strictly one at a time: a second
 * `say()` / `confront()` while one is still waiting on the backend throws
 * instead of racing it (two in flight would both read the same history and
 * could both break the same lie). A front end that can double-submit should
 * disable input until the pending turn settles.
 */
export class Dialogue {
  readonly #state: GameState;
  readonly #backend: LlmBackend;
  /** Conversation history per NPC, so each remembers its own thread. */
  readonly #histories = new Map<NpcId, ChatMessage[]>();
  #busy = false;

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
  say(npcId: NpcId, playerLine: string): Promise<SayResult> {
    return this.#oneAtATime(() => this.#say(npcId, playerLine));
  }

  async #say(npcId: NpcId, playerLine: string): Promise<SayResult> {
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
   * Presents `evidenceId` to `npcId`. If the player doesn't actually hold
   * that evidence, or it doesn't break any of their active lies, the backend
   * is never called and nothing changes — there's nothing to confront them
   * with, or nothing for the model to react to. If it does break something,
   * the model is asked to react *before* anything commits:
   * `GameState.present()` (which marks the lie broken and grants its facts)
   * and the history append both happen only once the backend has actually
   * answered, so a failed call leaves the lie standing, exactly as if
   * `/show` had never been tried.
   */
  confront(npcId: NpcId, evidenceId: EvidenceId, playerLine: string): Promise<ConfrontResult> {
    return this.#oneAtATime(() => this.#confront(npcId, evidenceId, playerLine));
  }

  async #confront(
    npcId: NpcId,
    evidenceId: EvidenceId,
    playerLine: string,
  ): Promise<ConfrontResult> {
    const npc = this.#npc(npcId);
    // findBreakingLie() also refuses evidence the player does not hold.
    const lie = this.#state.findBreakingLie(npcId, evidenceId);
    if (!lie) return { broken: false };

    // The lie hasn't broken yet at prompt-build time, so it's still "active"
    // — excluded here so the model isn't simultaneously told to answer with
    // the claim (this section) and, via the directive below, that the same
    // claim was just caught as a lie.
    const { system } = buildNpcPrompt(this.#state, npcId, npc, playerLine, {
      excludeLieIds: [lie.id],
    });
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
    //
    // recordTurn() runs first, against exactly the state the prompt above was
    // built from. Calling present() first would let its on_broken.grants
    // satisfy some other knowledge entry's `requires` before recordTurn()
    // ever ran, disclosing it in this same turn despite it never having been
    // part of the prompt actually sent (the same class of bug fixed in
    // recordTurn() itself — see its own doc comment).
    const turnGranted = this.#state.recordTurn(npcId, npc, playerLine);
    const presentGranted = this.#state.present(npcId, evidenceId).granted;

    history.push({ role: "user", content: playerLine });
    history.push({ role: "assistant", content: reply });
    this.#histories.set(npcId, history);

    return { broken: true, lie, reply, granted: [...turnGranted, ...presentGranted] };
  }

  async #oneAtATime<T>(turn: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("a turn is already in progress");
    this.#busy = true;
    try {
      return await turn();
    } finally {
      this.#busy = false;
    }
  }

  #npc(npcId: NpcId): Npc {
    const npc = this.#state.scenario.npcs[npcId];
    if (!npc) throw new Error(`no such npc: ${npcId}`);
    return npc;
  }
}
