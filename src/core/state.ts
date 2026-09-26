/**
 * The player's progress, and every rule that decides whether it advances.
 *
 * No function in this file talks to an LLM. Progression is a matter of which
 * facts hold, and that is settled by comparing ids — so the same accusation
 * always gets the same verdict.
 */

import { matchesAny } from "./match.ts";
import type {
  EvidenceId,
  FactId,
  Knowledge,
  Lie,
  Npc,
  NpcId,
  Scenario,
  Solution,
} from "./types.ts";

export interface AccusationInput {
  solutionId: string;
  /** Slot id → the option the player chose. */
  answers: Record<string, string>;
}

export type AccusationVerdict =
  /** `requires` is not satisfied yet; the accusation was not even scored. */
  | { kind: "locked"; missing: FactId[] }
  /** Some slots were left blank. */
  | { kind: "incomplete"; missing: string[] }
  /**
   * Scored and wrong. Deliberately carries no detail: revealing which slots
   * were right turns one combined guess into a per-slot brute force.
   */
  | { kind: "wrong" }
  | { kind: "solved"; narration: string };

export interface PresentVerdict {
  /** True when this evidence collapsed one of the NPC's lies. */
  broken: boolean;
  /** The lie that fell, when one did. */
  lie?: Lie;
  /** Facts newly established by the confrontation. */
  granted: FactId[];
}

export class GameState {
  readonly scenario: Scenario;
  readonly #facts = new Set<FactId>();
  /** Keyworded knowledge already disclosed, keyed as `npcId:knowledgeId`. */
  readonly #disclosed = new Set<string>();
  /** Lies already told to the player, keyed as `npcId:lieId`. */
  readonly #liesTold = new Set<string>();
  /** Lies already broken, keyed as `npcId:lieId`. */
  readonly #liesBroken = new Set<string>();
  readonly #solved = new Set<string>();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  // --- facts ---------------------------------------------------------------

  has(fact: FactId): boolean {
    return this.#facts.has(fact);
  }

  /** True only when every fact holds. An empty list is trivially satisfied. */
  hasAll(facts: readonly FactId[]): boolean {
    return facts.every((f) => this.#facts.has(f));
  }

  missing(facts: readonly FactId[]): FactId[] {
    return facts.filter((f) => !this.#facts.has(f));
  }

  /** Establishes facts, ignoring ones that already hold. Returns the new ones. */
  grant(facts: readonly FactId[] = []): FactId[] {
    const added: FactId[] = [];
    for (const f of facts) {
      if (!this.#facts.has(f)) {
        this.#facts.add(f);
        added.push(f);
      }
    }
    return added;
  }

  get facts(): FactId[] {
    return [...this.#facts];
  }

  // --- knowledge disclosure ------------------------------------------------

  /**
   * What belongs in this turn's prompt: background knowledge (no `keywords`),
   * anything already disclosed in an earlier turn (an NPC does not forget what
   * it already said), and anything whose `keywords` the player's current line
   * just matched. `requires` still gates all three — see `docs/schema.md`.
   */
  promptKnowledge(npcId: NpcId, npc: Npc, playerLine: string): Knowledge[] {
    return npc.knowledge.filter((k) => {
      if (!this.hasAll(k.requires)) return false;
      if (!k.keywords || k.keywords.length === 0) return true;
      if (this.#disclosed.has(`${npcId}:${k.id}`)) return true;
      return matchesAny(playerLine, k.keywords);
    });
  }

  // --- lies ----------------------------------------------------------------

  /** Lies this NPC has not yet been caught in, and so will still tell. */
  activeLies(npcId: NpcId, npc: Npc): Lie[] {
    return npc.lies.filter((l) => !this.#liesBroken.has(`${npcId}:${l.id}`));
  }

  isBroken(npcId: NpcId, lieId: string): boolean {
    return this.#liesBroken.has(`${npcId}:${lieId}`);
  }

  /**
   * Settles one turn of conversation: keyworded knowledge the player's line
   * just matched becomes disclosed (sticky from here on), and an active lie
   * whose keywords it matched counts as told. Nothing here reads what the
   * model replied — only what the player asked determines what stuck.
   *
   * Every match is decided against the state as it stood when this call
   * began, *before* anything below grants a single fact. Granting inside the
   * loop would let one entry's `grants` satisfy a second entry's `requires`
   * in the same turn, disclosing something that was never actually in the
   * prompt this turn's `promptKnowledge()` call built (e.g. a single line
   * matching both `saw_cloak`'s and the `requires: ["saw_cloak"]` entry's
   * keywords must only disclose the first).
   *
   * Call this only after the backend has actually answered; a failed turn
   * should record nothing (see `src/core/dialogue.ts`).
   */
  recordTurn(npcId: NpcId, npc: Npc, playerLine: string): FactId[] {
    const newlyDisclosed = npc.knowledge.filter((k) => {
      if (!k.keywords || k.keywords.length === 0) return false;
      if (!this.hasAll(k.requires)) return false;
      if (this.#disclosed.has(`${npcId}:${k.id}`)) return false;
      return matchesAny(playerLine, k.keywords);
    });

    const newlyTold = this.activeLies(npcId, npc).filter((lie) => {
      if (this.#liesTold.has(`${npcId}:${lie.id}`)) return false;
      return matchesAny(playerLine, lie.keywords);
    });

    const granted: FactId[] = [];
    for (const k of newlyDisclosed) {
      this.#disclosed.add(`${npcId}:${k.id}`);
      granted.push(...this.grant(k.grants));
    }
    for (const lie of newlyTold) {
      this.#liesTold.add(`${npcId}:${lie.id}`);
      granted.push(...this.grant(lie.grants_on_told));
    }

    return granted;
  }

  /**
   * Confronts an NPC with a piece of evidence. Whether a lie falls is decided
   * by an id lookup, never by asking the model to judge the contradiction.
   */
  present(npcId: NpcId, evidenceId: EvidenceId): PresentVerdict {
    const npc = this.scenario.npcs[npcId];
    if (!npc) return { broken: false, granted: [] };

    for (const lie of this.activeLies(npcId, npc)) {
      if (!lie.broken_by.includes(evidenceId)) continue;
      // A lie can only be broken once the player has actually heard it;
      // otherwise evidence would resolve a contradiction never established.
      if (!this.#liesTold.has(`${npcId}:${lie.id}`)) continue;

      this.#liesBroken.add(`${npcId}:${lie.id}`);
      return {
        broken: true,
        lie,
        granted: this.grant(lie.on_broken.grants),
      };
    }
    return { broken: false, granted: [] };
  }

  // --- inventory -----------------------------------------------------------

  /** Evidence the player currently holds. */
  heldEvidence(): EvidenceId[] {
    return Object.entries(this.scenario.world.evidence)
      .filter(([, e]) => this.hasAll(e.acquired_by))
      .map(([id]) => id);
  }

  holds(evidenceId: EvidenceId): boolean {
    const e = this.scenario.world.evidence[evidenceId];
    return e !== undefined && this.hasAll(e.acquired_by);
  }

  // --- accusation ----------------------------------------------------------

  isSolved(solutionId: string): boolean {
    return this.#solved.has(solutionId);
  }

  solutionById(id: string): Solution | undefined {
    return this.scenario.world.solutions.find((s) => s.id === id);
  }

  /** Unsolved solutions whose `requires` currently hold — the ones worth offering the player. */
  attemptableSolutions(): Solution[] {
    return this.scenario.world.solutions.filter(
      (s) => !this.isSolved(s.id) && this.hasAll(s.requires),
    );
  }

  /**
   * Scores an accusation. Every slot must be right at once, and a wrong
   * verdict says nothing about which slots were wrong (see `AccusationVerdict`).
   */
  accuse(input: AccusationInput): AccusationVerdict {
    const solution = this.solutionById(input.solutionId);
    if (!solution) return { kind: "wrong" };

    const missingFacts = this.missing(solution.requires);
    if (missingFacts.length > 0) {
      return { kind: "locked", missing: missingFacts };
    }

    const blank = solution.slots
      .filter((s) => !input.answers[s.id])
      .map((s) => s.id);
    if (blank.length > 0) return { kind: "incomplete", missing: blank };

    const allCorrect = solution.slots.every(
      (s) => input.answers[s.id] === s.answer,
    );
    if (!allCorrect) return { kind: "wrong" };

    this.#solved.add(solution.id);
    return { kind: "solved", narration: solution.on_solved };
  }
}
