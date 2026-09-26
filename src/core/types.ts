/**
 * Data shapes for a scenario, as loaded from `world.json` and `npc.json`.
 *
 * Everything a scenario author writes lives here. The engine reads these and
 * never asks the LLM to decide whether the player has made progress — see
 * `docs/schema.md` for why that line is drawn where it is.
 */

/** An id referring to a `World["facts"]` entry. */
export type FactId = string;

/** An id referring to a `World["evidence"]` entry. */
export type EvidenceId = string;

/** An id referring to a key of the `Npc` record. */
export type NpcId = string;

export interface Fact {
  /** Human-readable description, shown to the player in their notes. */
  label: string;
}

export interface Evidence {
  label: string;
  /** Shown when the player examines the item. */
  description: string;
  /** The item enters the player's hands once every one of these facts holds. */
  acquired_by: FactId[];
}

/** One blank the player must fill in to close a case. */
export interface SolutionSlot {
  id: string;
  /** Prompt shown to the player, e.g. "誰が". */
  question: string;
  /** The single correct choice. Never sent to the LLM. */
  answer: string;
  /** Everything selectable, including the answer. */
  options: string[];
}

/**
 * A case that can be closed. Obra Dinn style: every slot must be correct at
 * the same time, and the player is told only whether the whole set was right.
 */
export interface Solution {
  id: string;
  label: string;
  slots: SolutionSlot[];
  /** The accusation cannot even be attempted until all of these facts hold. */
  requires: FactId[];
  /** Narration shown once the case is closed. */
  on_solved: string;
}

export interface World {
  title: string;
  synopsis: string;
  /** Context every NPC may freely draw on; always present in their prompt. */
  common_knowledge: string[];
  facts: Record<FactId, Fact>;
  evidence: Record<EvidenceId, Evidence>;
  solutions: Solution[];
}

/** How an NPC speaks. Rendered into their system prompt verbatim. */
export interface Persona {
  first_person: string;
  speech: string;
  extra?: string;
}

/**
 * One thing an NPC knows. Withheld from the prompt entirely until `requires`
 * holds, so a model that never received the text cannot leak it.
 *
 * Disclosure itself is decided by keyword match against the player's line,
 * never by reading what the model actually said — see `src/core/match.ts`.
 */
export interface Knowledge {
  id: string;
  content: string;
  requires: FactId[];
  /**
   * Substrings (after NFKC + lowercase normalization) that the player's line
   * must contain for this to count as disclosed. Omitted, this is background
   * knowledge: always in the prompt once `requires` holds, and it may not
   * carry `grants` — there would be no turn at which to grant it.
   */
  keywords?: string[];
  /** Facts that start holding once this has been disclosed to the player. */
  grants?: FactId[];
}

/** What happens when a lie is broken by the right piece of evidence. */
export interface LieBreak {
  /** Stage direction handed to the LLM, e.g. "動揺して口ごもる". */
  reaction: string;
  grants: FactId[];
}

/**
 * A lie an NPC tells. `claim` is presented to the model as plain truth so the
 * lie comes out naturally; `truth` stays engine-side until the lie is broken.
 */
export interface Lie {
  id: string;
  /** What subject triggers the lie, e.g. "昨夜どこにいたか". Prompt wording only. */
  topic: string;
  claim: string;
  truth: string;
  /**
   * Substrings (after NFKC + lowercase normalization) that the player's line
   * must contain for the lie to count as told to them. Unlike `Knowledge`,
   * this is never optional: a lie the player never asked about was never told.
   */
  keywords: string[];
  /** Facts that hold once the player has been told the lie. */
  grants_on_told?: FactId[];
  /** Evidence that collapses the lie when presented. */
  broken_by: EvidenceId[];
  on_broken: LieBreak;
}

export interface Npc {
  name: string;
  role: string;
  persona: Persona;
  knowledge: Knowledge[];
  /** Subjects this NPC must refuse rather than invent an answer for. */
  unknown: string[];
  lies: Lie[];
}

export type NpcBook = Record<NpcId, Npc>;

/** A world plus its cast, already parsed and cross-checked. */
export interface Scenario {
  world: World;
  npcs: NpcBook;
}
