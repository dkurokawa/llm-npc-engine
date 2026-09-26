/**
 * Loads and cross-checks a scenario.
 *
 * A scenario file is arbitrary JSON off disk. It is run through the zod
 * schemas in `schema.ts` first — a typo'd key or a wrong type is reported by
 * name rather than surfacing later as `undefined` deep in a template string.
 * Only once the shape is right does this file check the ids inside it: a
 * typo in `requires` would otherwise surface as a piece of dialogue that
 * never unlocks — a bug that looks exactly like a scenario the author wrote
 * badly on purpose, and so is very hard to spot while playing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { npcBookSchema, worldSchema } from "./schema.ts";
import type { NpcBook, Scenario, World } from "./types.ts";
import type { z } from "zod";

export class ScenarioError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`scenario is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ScenarioError";
    this.problems = problems;
  }
}

/** Renders a zod issue path as `a.b[2].c`, the way the rest of this file's messages read. */
function formatPath(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    const key = String(segment);
    return acc ? `${acc}.${key}` : key;
  }, "");
}

function formatZodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const suffix = formatPath(issue.path);
    return `${suffix ? `${prefix}.${suffix}` : prefix}: ${issue.message}`;
  });
}

/**
 * Everything the schema cannot express: ids that must point at something
 * that exists, ids that must be unique within their scope, and shapes that
 * are individually well-typed but jointly nonsensical (an evidence with no
 * way to acquire it, a lie no keyword can ever trigger).
 */
function crossCheck(world: World, npcs: NpcBook): string[] {
  const problems: string[] = [];
  const factIds = new Set(Object.keys(world.facts));
  const evidenceIds = new Set(Object.keys(world.evidence));

  const checkFacts = (where: string, ids: readonly string[] = []) => {
    for (const id of ids) {
      if (!factIds.has(id)) problems.push(`${where}: unknown fact "${id}"`);
    }
  };

  const hasEmptyKeyword = (keywords: readonly string[]) =>
    keywords.some((k) => k.trim() === "");

  if (Object.keys(npcs).length === 0) {
    problems.push("npcs: needs at least one NPC");
  }
  if (world.solutions.length === 0) {
    problems.push("world.solutions: needs at least one solution");
  }

  for (const [id, ev] of Object.entries(world.evidence)) {
    checkFacts(`evidence.${id}.acquired_by`, ev.acquired_by);
    if (ev.acquired_by.length === 0) {
      // Nothing to satisfy means this evidence would be held from turn one.
      problems.push(`evidence.${id}.acquired_by: needs at least one fact`);
    }
  }

  const solutionIds = new Set<string>();
  for (const sol of world.solutions) {
    if (solutionIds.has(sol.id)) problems.push(`solutions.${sol.id}: duplicate solution id`);
    solutionIds.add(sol.id);

    checkFacts(`solutions.${sol.id}.requires`, sol.requires);
    if (sol.slots.length === 0) {
      problems.push(`solutions.${sol.id}: needs at least one slot`);
    }

    const slotIds = new Set<string>();
    for (const slot of sol.slots) {
      if (slotIds.has(slot.id)) {
        problems.push(`solutions.${sol.id}.slots.${slot.id}: duplicate slot id`);
      }
      slotIds.add(slot.id);

      if (!slot.options.includes(slot.answer)) {
        problems.push(
          `solutions.${sol.id}.slots.${slot.id}: answer "${slot.answer}" is not among its options`,
        );
      }
      if (slot.options.length < 2) {
        // A single-option slot is decoration: it cannot be answered wrongly,
        // so it weakens the multi-condition lock without looking like it does.
        problems.push(`solutions.${sol.id}.slots.${slot.id}: needs at least two options`);
      }
    }
  }

  for (const [npcId, npc] of Object.entries(npcs)) {
    const knowledgeIds = new Set<string>();
    for (const k of npc.knowledge) {
      if (knowledgeIds.has(k.id)) {
        problems.push(`npcs.${npcId}.knowledge.${k.id}: duplicate knowledge id`);
      }
      knowledgeIds.add(k.id);

      checkFacts(`npcs.${npcId}.knowledge.${k.id}.requires`, k.requires);
      checkFacts(`npcs.${npcId}.knowledge.${k.id}.grants`, k.grants);

      if ((k.grants?.length ?? 0) > 0 && (k.keywords?.length ?? 0) === 0) {
        // Background knowledge (no keywords) is always on; it can never be
        // the thing that "just got disclosed", so it cannot grant a fact.
        problems.push(
          `npcs.${npcId}.knowledge.${k.id}: has grants but no keywords, so it could never be disclosed`,
        );
      }
      if (k.keywords && hasEmptyKeyword(k.keywords)) {
        problems.push(`npcs.${npcId}.knowledge.${k.id}.keywords: contains an empty keyword`);
      }
    }

    const lieIds = new Set<string>();
    for (const lie of npc.lies) {
      if (lieIds.has(lie.id)) problems.push(`npcs.${npcId}.lies.${lie.id}: duplicate lie id`);
      lieIds.add(lie.id);

      checkFacts(`npcs.${npcId}.lies.${lie.id}.grants_on_told`, lie.grants_on_told);
      checkFacts(`npcs.${npcId}.lies.${lie.id}.on_broken.grants`, lie.on_broken.grants);

      if (lie.keywords.length === 0) {
        problems.push(`npcs.${npcId}.lies.${lie.id}.keywords: needs at least one keyword`);
      }
      if (hasEmptyKeyword(lie.keywords)) {
        problems.push(`npcs.${npcId}.lies.${lie.id}.keywords: contains an empty keyword`);
      }

      if (lie.broken_by.length === 0) {
        // An unbreakable lie is a dead end: the player can never get past it.
        problems.push(`npcs.${npcId}.lies.${lie.id}: needs at least one broken_by evidence`);
      }
      for (const ev of lie.broken_by) {
        if (!evidenceIds.has(ev)) {
          problems.push(`npcs.${npcId}.lies.${lie.id}.broken_by: unknown evidence "${ev}"`);
        }
      }
    }
  }

  return problems;
}

interface ParseResult {
  scenario?: Scenario;
  problems: string[];
}

/**
 * Runs both passes: schema first, cross-references second. A schema failure
 * skips cross-checking entirely — ids and counts are meaningless to check
 * against a shape that was never confirmed to hold them.
 */
function parseScenario(worldInput: unknown, npcsInput: unknown): ParseResult {
  const worldResult = worldSchema.safeParse(worldInput);
  const npcsResult = npcBookSchema.safeParse(npcsInput);

  if (!worldResult.success || !npcsResult.success) {
    const problems: string[] = [];
    if (!worldResult.success) problems.push(...formatZodIssues("world", worldResult.error));
    if (!npcsResult.success) problems.push(...formatZodIssues("npcs", npcsResult.error));
    return { problems };
  }

  const problems = crossCheck(worldResult.data, npcsResult.data);
  if (problems.length > 0) return { problems };
  return { scenario: { world: worldResult.data, npcs: npcsResult.data }, problems: [] };
}

/** Reports every problem at once, so an author fixes them in one pass. */
export function validateScenario(worldInput: unknown, npcsInput: unknown): string[] {
  return parseScenario(worldInput, npcsInput).problems;
}

/** Reads `world.json` and `npc.json` from a directory and validates them. */
export async function loadScenario(dir: string): Promise<Scenario> {
  const [worldRaw, npcRaw] = await Promise.all([
    readFile(path.join(dir, "world.json"), "utf8"),
    readFile(path.join(dir, "npc.json"), "utf8"),
  ]);

  const worldJson: unknown = JSON.parse(worldRaw);
  const npcsJson: unknown = JSON.parse(npcRaw);

  const { scenario, problems } = parseScenario(worldJson, npcsJson);
  if (!scenario) throw new ScenarioError(problems);
  return scenario;
}
