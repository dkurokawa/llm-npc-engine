import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";

import { loadScenario, ScenarioError, validateScenario } from "./load.ts";
import type { Scenario } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(here, "..", "..", "scenarios", "sample");

let sample: Scenario;
before(async () => {
  sample = await loadScenario(SAMPLE_DIR);
});

describe("schema validation", () => {
  test("the sample scenario passes with no problems", () => {
    assert.deepEqual(validateScenario(sample.world, sample.npcs), []);
  });

  test("knowledge.requires may be omitted and defaults to an empty array", () => {
    const martha = sample.npcs.martha!;
    const { requires: _requires, ...withoutRequires } = martha.knowledge[0]!;
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      martha: { ...martha, knowledge: [withoutRequires, ...martha.knowledge.slice(1)] },
    });
    assert.deepEqual(problems, []);
  });

  test("an empty input reports every missing field, all under world.", () => {
    const problems = validateScenario({}, {});
    assert.ok(problems.length > 0);
    assert.ok(
      problems.every((p) => p.startsWith("world.")),
      "an empty npcs object is valid (zero NPCs is a cross-check concern, not a shape one)",
    );
  });

  test("a field of the wrong type is reported by its own path", () => {
    const problems = validateScenario({ ...sample.world, title: 42 }, sample.npcs);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^world\.title:/);
  });

  test("an unknown key anywhere in the object is rejected", () => {
    const problems = validateScenario({ ...sample.world, bogus: true }, sample.npcs);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /world: Unrecognized key/i);
  });

  test("an npc key containing a disallowed character (e.g. a colon) is rejected", () => {
    // Every id ends up as half of an internal composite key (`npcId:id`, see
    // state.ts); an id containing `:` could collide with an unrelated pair.
    const problems = validateScenario(sample.world, { ...sample.npcs, "a:b": sample.npcs.gareth! });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^npcs\.a:b:/);
  });

  test("a knowledge id containing a disallowed character is rejected", () => {
    const gareth = sample.npcs.gareth!;
    const bad = gareth.knowledge.map((k) =>
      k.id === "cloak_man_stayed" ? { ...k, id: "cloak:man" } : k,
    );
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      gareth: { ...gareth, knowledge: bad },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^npcs\.gareth\.knowledge\[0\]\.id: must match/);
  });

  test("a schema failure skips cross-reference checking entirely", () => {
    // Both a bad type (npc-side) and a dangling fact (world-side) are present;
    // only the schema problem should be reported.
    const problems = validateScenario(
      { ...sample.world, solutions: [{ ...sample.world.solutions[0]!, requires: ["nope"] }] },
      { ...sample.npcs, gareth: { ...sample.npcs.gareth!, name: 42 } },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^npcs\.gareth\.name:/);
  });
});

describe("cross-reference checks", () => {
  test("a dangling fact reference is reported", () => {
    const problems = validateScenario(
      { ...sample.world, solutions: [{ ...sample.world.solutions[0]!, requires: ["nope"] }] },
      sample.npcs,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /unknown fact "nope"/);
  });

  test("an answer outside its own options is reported", () => {
    const solution = sample.world.solutions[0]!;
    const problems = validateScenario(
      {
        ...sample.world,
        solutions: [
          {
            ...solution,
            slots: [{ ...solution.slots[0]!, answer: "nobody" }, ...solution.slots.slice(1)],
          },
        ],
      },
      sample.npcs,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /not among its options/);
  });

  test("zero NPCs is rejected", () => {
    const problems = validateScenario(sample.world, {});
    assert.ok(problems.includes("npcs: needs at least one NPC"));
  });

  test("zero solutions is rejected", () => {
    const problems = validateScenario({ ...sample.world, solutions: [] }, sample.npcs);
    assert.ok(problems.includes("world.solutions: needs at least one solution"));
  });

  test("a duplicate solution id is reported", () => {
    const solution = sample.world.solutions[0]!;
    const problems = validateScenario(
      { ...sample.world, solutions: [solution, { ...solution }] },
      sample.npcs,
    );
    assert.ok(problems.some((p) => p.includes("duplicate solution id")));
  });

  test("a duplicate slot id within one solution is reported", () => {
    const solution = sample.world.solutions[0]!;
    const [first, second, ...rest] = solution.slots;
    const problems = validateScenario(
      {
        ...sample.world,
        solutions: [{ ...solution, slots: [first!, { ...second!, id: first!.id }, ...rest] }],
      },
      sample.npcs,
    );
    assert.ok(problems.some((p) => p.includes("duplicate slot id")));
  });

  test("a duplicate knowledge id within one NPC is reported", () => {
    const gareth = sample.npcs.gareth!;
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      gareth: { ...gareth, knowledge: [gareth.knowledge[0]!, { ...gareth.knowledge[0]! }] },
    });
    assert.ok(problems.some((p) => p.includes("duplicate knowledge id")));
  });

  test("a duplicate lie id within one NPC is reported", () => {
    const martha = sample.npcs.martha!;
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      martha: { ...martha, lies: [martha.lies[0]!, { ...martha.lies[0]! }] },
    });
    assert.ok(problems.some((p) => p.includes("duplicate lie id")));
  });

  test("evidence with an empty acquired_by is rejected (it would start held)", () => {
    const problems = validateScenario(
      {
        ...sample.world,
        evidence: {
          ...sample.world.evidence,
          umbrella: { label: "傘", description: "誰かの忘れ物", acquired_by: [] },
        },
      },
      sample.npcs,
    );
    assert.ok(problems.some((p) => p === "evidence.umbrella.acquired_by: needs at least one fact"));
  });

  test("knowledge with grants but no keywords is rejected", () => {
    const gareth = sample.npcs.gareth!;
    const noKeywords = gareth.knowledge.map((k) =>
      k.id === "cloak_man_stayed" ? { ...k, keywords: undefined } : k,
    );
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      gareth: { ...gareth, knowledge: noKeywords },
    });
    assert.ok(
      problems.some((p) => p === "npcs.gareth.knowledge.cloak_man_stayed: has grants but no keywords, so it could never be disclosed"),
    );
  });

  test("a lie with an empty keywords list is rejected", () => {
    const martha = sample.npcs.martha!;
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      martha: { ...martha, lies: martha.lies.map((l) => ({ ...l, keywords: [] })) },
    });
    assert.ok(problems.some((p) => p.includes("needs at least one keyword")));
  });

  test("an empty-string keyword is rejected", () => {
    const gareth = sample.npcs.gareth!;
    const blank = gareth.knowledge.map((k) =>
      k.id === "cloak_man_stayed" ? { ...k, keywords: ["昨夜", ""] } : k,
    );
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      gareth: { ...gareth, knowledge: blank },
    });
    assert.ok(problems.some((p) => p.includes("contains an empty keyword")));
  });

  test("an unbreakable lie (no broken_by) is rejected", () => {
    const martha = sample.npcs.martha!;
    const problems = validateScenario(sample.world, {
      ...sample.npcs,
      martha: { ...martha, lies: martha.lies.map((l) => ({ ...l, broken_by: [] })) },
    });
    assert.ok(problems.some((p) => p.includes("needs at least one broken_by evidence")));
  });
});

describe("loadScenario", () => {
  test("loads and cross-checks the real sample directory", async () => {
    const scenario = await loadScenario(SAMPLE_DIR);
    assert.deepEqual(Object.keys(scenario.npcs).sort(), ["gareth", "martha"]);
  });

  test("throws a ScenarioError carrying every problem for an invalid scenario on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "llm-npc-engine-test-"));
    try {
      await writeFile(
        path.join(dir, "world.json"),
        JSON.stringify({ ...sample.world, title: 42 }),
      );
      await writeFile(path.join(dir, "npc.json"), JSON.stringify(sample.npcs));

      await assert.rejects(() => loadScenario(dir), (err: unknown) => {
        assert.ok(err instanceof ScenarioError);
        assert.deepEqual(err.problems, [
          "world.title: Invalid input: expected string, received number",
        ]);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
