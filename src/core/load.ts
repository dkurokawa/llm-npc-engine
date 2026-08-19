/**
 * Loads and cross-checks a scenario.
 *
 * Every id is verified against the thing it points at. A typo in `requires`
 * would otherwise surface as a piece of dialogue that never unlocks — a bug
 * that looks exactly like a scenario the author wrote badly on purpose, and so
 * is very hard to spot while playing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NpcBook, Scenario, World } from "./types.ts";

export class ScenarioError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`scenario is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ScenarioError";
    this.problems = problems;
  }
}

/** Reports every problem at once, so an author fixes them in one pass. */
export function validateScenario(world: World, npcs: NpcBook): string[] {
  const problems: string[] = [];
  const factIds = new Set(Object.keys(world.facts ?? {}));
  const evidenceIds = new Set(Object.keys(world.evidence ?? {}));

  const checkFacts = (where: string, ids: readonly string[] = []) => {
    for (const id of ids) {
      if (!factIds.has(id)) problems.push(`${where}: unknown fact "${id}"`);
    }
  };

  for (const [id, ev] of Object.entries(world.evidence ?? {})) {
    checkFacts(`evidence.${id}.acquired_by`, ev.acquired_by);
  }

  for (const sol of world.solutions ?? []) {
    checkFacts(`solutions.${sol.id}.requires`, sol.requires);
    if (sol.slots.length === 0) {
      problems.push(`solutions.${sol.id}: needs at least one slot`);
    }
    for (const slot of sol.slots) {
      if (!slot.options.includes(slot.answer)) {
        problems.push(
          `solutions.${sol.id}.slots.${slot.id}: answer "${slot.answer}" is not among its options`,
        );
      }
      if (slot.options.length < 2) {
        // A single-option slot is decoration: it cannot be answered wrongly,
        // so it weakens the multi-condition lock without looking like it does.
        problems.push(
          `solutions.${sol.id}.slots.${slot.id}: needs at least two options`,
        );
      }
    }
  }

  for (const [npcId, npc] of Object.entries(npcs)) {
    for (const k of npc.knowledge ?? []) {
      checkFacts(`npcs.${npcId}.knowledge.${k.id}.requires`, k.requires);
      checkFacts(`npcs.${npcId}.knowledge.${k.id}.grants`, k.grants);
    }
    for (const lie of npc.lies ?? []) {
      checkFacts(`npcs.${npcId}.lies.${lie.id}.grants_on_told`, lie.grants_on_told);
      checkFacts(`npcs.${npcId}.lies.${lie.id}.on_broken.grants`, lie.on_broken?.grants);
      if (!lie.broken_by || lie.broken_by.length === 0) {
        // An unbreakable lie is a dead end: the player can never get past it.
        problems.push(`npcs.${npcId}.lies.${lie.id}: needs at least one broken_by evidence`);
      }
      for (const ev of lie.broken_by ?? []) {
        if (!evidenceIds.has(ev)) {
          problems.push(`npcs.${npcId}.lies.${lie.id}.broken_by: unknown evidence "${ev}"`);
        }
      }
    }
  }

  return problems;
}

/** Reads `world.json` and `npc.json` from a directory and validates them. */
export async function loadScenario(dir: string): Promise<Scenario> {
  const [worldRaw, npcRaw] = await Promise.all([
    readFile(path.join(dir, "world.json"), "utf8"),
    readFile(path.join(dir, "npc.json"), "utf8"),
  ]);

  const world = JSON.parse(worldRaw) as World;
  const npcs = JSON.parse(npcRaw) as NpcBook;

  const problems = validateScenario(world, npcs);
  if (problems.length > 0) throw new ScenarioError(problems);

  return { world, npcs };
}
