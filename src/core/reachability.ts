/**
 * Checks that every solution, every piece of knowledge, and every piece of
 * evidence can actually be reached from nothing — not just that the ids they
 * reference exist (`load.ts`'s cross-reference checks already cover that).
 *
 * A scenario can pass every cross-reference check and still be unwinnable:
 * evidence A requires fact B, but B only holds once evidence A has been
 * presented. Nothing in `world.json`/`npc.json` forbids writing that, and it
 * reads exactly like a scenario the author meant to be hard, right up until
 * someone tries to actually finish it.
 *
 * This runs the same "which facts hold" model `GameState` uses, but forward
 * from an empty fact set to a fixed point, instead of from what the player
 * has actually done. It assumes every id reference already points at
 * something real — call it only after cross-reference checks have passed, or
 * a dangling reference would just look like an unreachable fact forever.
 */

import type { EvidenceId, FactId, NpcBook, World } from "./types.ts";

/** The result of running every knowledge/lie/evidence rule to a fixed point. */
interface Closure {
  /** Every fact reachable by some sequence of turns, however long. */
  facts: ReadonlySet<FactId>;
  /** Every evidence id whose `acquired_by` is satisfiable by `facts`. */
  obtainableEvidence: ReadonlySet<EvidenceId>;
}

/**
 * Grows `facts`/`evidence` to their least fixed point. Unlike
 * `GameState.recordTurn`, this has no notion of "one turn" to keep isolated —
 * it is asking whether something is reachable at all, over any number of
 * turns, so letting one grant feed the very next check in the same pass only
 * gets there faster; it does not change which facts end up reachable.
 */
function computeClosure(world: World, npcs: NpcBook): Closure {
  const facts = new Set<FactId>();
  const hasAll = (ids: readonly FactId[]) => ids.every((id) => facts.has(id));

  let obtainableEvidence = new Set<EvidenceId>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const npc of Object.values(npcs)) {
      for (const k of npc.knowledge) {
        if (!hasAll(k.requires)) continue;
        for (const g of k.grants ?? []) {
          if (!facts.has(g)) {
            facts.add(g);
            changed = true;
          }
        }
      }
      for (const lie of npc.lies) {
        // No `requires` gates telling a lie: the topic can always be asked
        // about, so whatever it grants on being told is always reachable.
        for (const g of lie.grants_on_told ?? []) {
          if (!facts.has(g)) {
            facts.add(g);
            changed = true;
          }
        }
      }
    }

    obtainableEvidence = new Set(
      Object.entries(world.evidence)
        .filter(([, ev]) => hasAll(ev.acquired_by))
        .map(([id]) => id),
    );

    for (const npc of Object.values(npcs)) {
      for (const lie of npc.lies) {
        if (!lie.broken_by.some((ev) => obtainableEvidence.has(ev))) continue;
        for (const g of lie.on_broken.grants) {
          if (!facts.has(g)) {
            facts.add(g);
            changed = true;
          }
        }
      }
    }
  }

  return { facts, obtainableEvidence };
}

/**
 * Reports every evidence, solution, and knowledge entry nothing can ever
 * reach. Call only once cross-reference checks report no problems.
 */
export function checkReachability(world: World, npcs: NpcBook): string[] {
  const { facts, obtainableEvidence } = computeClosure(world, npcs);
  const hasAll = (ids: readonly FactId[]) => ids.every((id) => facts.has(id));
  const problems: string[] = [];

  for (const id of Object.keys(world.evidence)) {
    if (!obtainableEvidence.has(id)) {
      problems.push(
        `evidence.${id}: unreachable — no sequence of turns can ever satisfy acquired_by`,
      );
    }
  }

  for (const sol of world.solutions) {
    if (!hasAll(sol.requires)) {
      problems.push(`solutions.${sol.id}: unreachable — requires can never be fully satisfied`);
    }
  }

  for (const [npcId, npc] of Object.entries(npcs)) {
    for (const k of npc.knowledge) {
      if (!hasAll(k.requires)) {
        problems.push(
          `npcs.${npcId}.knowledge.${k.id}: unreachable — requires can never be satisfied`,
        );
      }
    }
  }

  return problems;
}
