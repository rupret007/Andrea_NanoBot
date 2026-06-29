import { describe, expect, it } from "vitest";
import { KnowledgeGraph } from "../src/memory/knowledge-graph.js";

describe("knowledge graph", () => {
  it("merges nodes by label/type", () => {
    const g = new KnowledgeGraph();
    const a = g.upsertNode({ label: "Stalemate", type: "Band" });
    const b = g.upsertNode({ label: "Stalemate", type: "Band", aliases: ["The Stalemates"] });
    expect(a.id).toBe(b.id);
    expect(b.aliases).toContain("The Stalemates");
  });

  it("expands neighborhoods within bounded depth", () => {
    const g = new KnowledgeGraph();
    const jeff = g.upsertNode({ label: "Jeff", type: "Person" });
    const stalemate = g.upsertNode({ label: "Stalemate", type: "Band" });
    const raddad = g.upsertNode({ label: "Rad Dad", type: "Band" });
    const tour = g.upsertNode({ label: "Spring Tour", type: "Event" });
    g.addEdge({ from: jeff.id, to: stalemate.id, predicate: "plays_in", observedAt: Date.now() });
    g.addEdge({ from: jeff.id, to: raddad.id, predicate: "plays_in", observedAt: Date.now() });
    g.addEdge({ from: raddad.id, to: tour.id, predicate: "schedules", observedAt: Date.now() });

    const oneHop = g.neighborhood(jeff.id, 1);
    expect(oneHop.nodes.map((n) => n.label).sort()).toEqual(["Jeff", "Rad Dad", "Stalemate"]);

    const twoHop = g.neighborhood(jeff.id, 2);
    expect(twoHop.nodes.map((n) => n.label)).toContain("Spring Tour");
  });

  it("merges by alias when caller supplies a new label that already lives as an alias", () => {
    const g = new KnowledgeGraph();
    const orig = g.upsertNode({
      label: "Stalemate",
      type: "Band",
      aliases: ["The Stalemates"],
    });
    // Caller now learns about "The Stalemates" with extra detail —
    // alias-driven merging should fold this into the original node.
    const merged = g.upsertNode({
      label: "The Stalemates",
      type: "Band",
      aliases: ["Stalemate (band)"],
      attrs: { genre: "rock" },
    });
    expect(merged.id).toBe(orig.id);
    expect(merged.aliases).toEqual(expect.arrayContaining(["The Stalemates", "Stalemate (band)"]));
    expect(merged.attrs).toEqual({ genre: "rock" });
    expect(g.stats().nodes).toBe(1);
  });

  it("preserves the original createdAt across merges", () => {
    const g = new KnowledgeGraph();
    const orig = g.upsertNode({ label: "Jeff", type: "Person" });
    const originalCreated = orig.createdAt;
    // Force a different supplied createdAt — must NOT overwrite.
    const merged = g.upsertNode({
      label: "Jeff",
      type: "Person",
      createdAt: originalCreated + 1_000_000,
    } as any);
    expect(merged.createdAt).toBe(originalCreated);
  });

  it("neighborhood terminates on graph cycles", () => {
    const g = new KnowledgeGraph();
    const a = g.upsertNode({ label: "A", type: "T" });
    const b = g.upsertNode({ label: "B", type: "T" });
    const c = g.upsertNode({ label: "C", type: "T" });
    g.addEdge({ from: a.id, to: b.id, predicate: "p", observedAt: 1 });
    g.addEdge({ from: b.id, to: c.id, predicate: "p", observedAt: 1 });
    g.addEdge({ from: c.id, to: a.id, predicate: "p", observedAt: 1 }); // cycle
    const r = g.neighborhood(a.id, 5);
    expect(r.nodes.map((n) => n.label).sort()).toEqual(["A", "B", "C"]);
    expect(r.edges).toHaveLength(3);
  });

  it("returns empty for unknown seedId", () => {
    const g = new KnowledgeGraph();
    g.upsertNode({ label: "Jeff", type: "Person" });
    const r = g.neighborhood("nope-not-here", 2);
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });
});
