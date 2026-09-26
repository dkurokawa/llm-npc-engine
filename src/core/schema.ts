/**
 * Runtime shapes for `world.json` / `npc.json`, checked with zod instead of
 * trusted with `as`. A scenario file is arbitrary JSON from disk; nothing
 * here assumes it matches `types.ts` until `safeParse` says so.
 *
 * The hand-written interfaces in `types.ts` stay authoritative for JSDoc and
 * for every other file's imports — this module only has to agree with them,
 * which the `Assert<Equals<...>>` lines below check at compile time. If a
 * field is added to one side and not the other, `tsc` fails here rather than
 * the mismatch surfacing later as a confusing shape at runtime.
 */

import { z } from "zod";

import type { NpcBook, Npc, World } from "./types.ts";

const factId = z.string();
const evidenceId = z.string();

/**
 * Every id that gets defined here (never a reference to one) ends up as half
 * of an internal composite key — `${npcId}:${knowledgeId}` and the like, see
 * `state.ts`. Restricting the character set is what keeps an id containing
 * `:` from colliding with a different (npcId, id) pair that happens to join
 * into the same string.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const scenarioId = z.string().regex(ID_PATTERN, `must match ${ID_PATTERN.toString()}`);

const factSchema = z
  .object({
    label: z.string(),
  })
  .strict();

const evidenceSchema = z
  .object({
    label: z.string(),
    description: z.string(),
    acquired_by: z.array(factId),
  })
  .strict();

const solutionSlotSchema = z
  .object({
    id: scenarioId,
    question: z.string(),
    answer: z.string(),
    options: z.array(z.string()),
  })
  .strict();

const solutionSchema = z
  .object({
    id: scenarioId,
    label: z.string(),
    slots: z.array(solutionSlotSchema),
    requires: z.array(factId),
    on_solved: z.string(),
  })
  .strict();

export const worldSchema = z
  .object({
    title: z.string(),
    synopsis: z.string(),
    common_knowledge: z.array(z.string()),
    facts: z.record(scenarioId, factSchema),
    evidence: z.record(scenarioId, evidenceSchema),
    solutions: z.array(solutionSchema),
  })
  .strict();

const personaSchema = z
  .object({
    first_person: z.string(),
    speech: z.string(),
    extra: z.string().optional(),
  })
  .strict();

const knowledgeSchema = z
  .object({
    id: scenarioId,
    content: z.string(),
    // Optional on input: background knowledge (no `keywords`) commonly has
    // nothing to require, and `[]` is trivially satisfied anyway (see
    // `GameState.hasAll`), so there's nothing lost in letting an author omit it.
    requires: z.array(factId).default([]),
    keywords: z.array(z.string()).optional(),
    grants: z.array(factId).optional(),
  })
  .strict();

const lieBreakSchema = z
  .object({
    reaction: z.string(),
    grants: z.array(factId),
  })
  .strict();

const lieSchema = z
  .object({
    id: scenarioId,
    topic: z.string(),
    claim: z.string(),
    truth: z.string(),
    keywords: z.array(z.string()),
    grants_on_told: z.array(factId).optional(),
    broken_by: z.array(evidenceId),
    on_broken: lieBreakSchema,
  })
  .strict();

export const npcSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    persona: personaSchema,
    knowledge: z.array(knowledgeSchema),
    unknown: z.array(z.string()),
    lies: z.array(lieSchema),
  })
  .strict();

export const npcBookSchema = z.record(scenarioId, npcSchema);

// --- schema/type parity, checked at compile time --------------------------

/** True iff `A` and `B` are assignable to each other in both directions. */
// The single-use `T` below is deliberate: it forces the conditional to be
// checked invariantly instead of distributing over unions, which is what
// makes this an equality test rather than a two-way `extends` check.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** Fails `tsc` (not a runtime check) unless `T` is exactly `true`. */
type Assert<T extends true> = T;

type _WorldSchemaMatchesType = Assert<Equals<z.infer<typeof worldSchema>, World>>;
type _NpcSchemaMatchesType = Assert<Equals<z.infer<typeof npcSchema>, Npc>>;
type _NpcBookSchemaMatchesType = Assert<Equals<z.infer<typeof npcBookSchema>, NpcBook>>;
