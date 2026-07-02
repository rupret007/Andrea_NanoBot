import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/safety/audit-log.js";
import { AuditLog, redactSecrets, shannonEntropy } from "../src/safety/audit-log.js";
import { CONSTITUTION_VERSION } from "../src/safety/constitution.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recomputeHash(line: string): { recomputed: string; entry: AuditEntry } {
  const entry = JSON.parse(line) as AuditEntry;
  const { hash, ...rest } = entry;
  const recomputed = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
  return { recomputed, entry };
}

describe("audit log", () => {
  it("writes hash-chained entries", async () => {
    const log = new AuditLog(join(dir, "audit.jsonl"));
    await log.load();
    const a = await log.write({ scope: "s", kind: "k1" });
    const b = await log.write({ scope: "s", kind: "k2" });
    expect(b.prevHash).toBe(a.hash);
  });

  it("redacts secret-shaped strings and the on-disk hash matches recomputation", async () => {
    const log = new AuditLog(join(dir, "audit.jsonl"));
    await log.load();
    await log.write({
      scope: "s",
      kind: "k",
      payload: { token: "sk-abcdefghijklmnopqrstuv" },
    });
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw).toContain("<redacted>");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuv");

    // Redact-then-hash: the on-disk hash must equal sha256 of the on-disk
    // line stripped of its `hash` field.
    const line = raw.split("\n").filter(Boolean)[0];
    const { recomputed, entry } = recomputeHash(line);
    expect(recomputed).toBe(entry.hash);
  });

  it("stamps every entry with the active constitution version", async () => {
    const log = new AuditLog(join(dir, "audit.jsonl"));
    await log.load();
    const a = await log.write({ scope: "s", kind: "k" });
    const b = await log.write({ scope: "s", kind: "k", payload: { x: 1 } });
    expect(a.constitutionVersion).toBe(CONSTITUTION_VERSION);
    expect(b.constitutionVersion).toBe(CONSTITUTION_VERSION);
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(JSON.parse(line).constitutionVersion).toBe(CONSTITUTION_VERSION);
    }
  });

  it("serializes concurrent write() calls so the chain stays intact", async () => {
    const log = new AuditLog(join(dir, "audit.jsonl"));
    await log.load();
    const N = 25;
    const writes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.write({ scope: "s", kind: `k${i}`, payload: { i } }),
      ),
    );
    // Every entry's prevHash must match the previous entry's hash, in the
    // order returned by Promise.all (which preserves the input order).
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i].prevHash).toBe(writes[i - 1].hash);
    }
    // And no hash collides (would indicate a fork).
    const hashes = new Set(writes.map((w) => w.hash));
    expect(hashes.size).toBe(N);

    // verifyChain on the on-disk file.
    const verify = await log.verifyChain();
    expect(verify.ok).toBe(true);
  });

  it("verifyChain returns ok on a clean log", async () => {
    const log = new AuditLog(join(dir, "audit.jsonl"));
    await log.load();
    await log.write({ scope: "s", kind: "k1" });
    await log.write({ scope: "s", kind: "k2" });
    await log.write({ scope: "s", kind: "k3" });
    const result = await log.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.brokenAtLine).toBeUndefined();
  });

  it("verifyChain reports the broken line when a middle entry is tampered", async () => {
    const path = join(dir, "audit.jsonl");
    const log = new AuditLog(path);
    await log.load();
    await log.write({ scope: "s", kind: "k1" });
    await log.write({ scope: "s", kind: "k2", payload: { v: 2 } });
    await log.write({ scope: "s", kind: "k3" });
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Tamper with the middle line: change the kind without recomputing the hash.
    const middle = JSON.parse(lines[1]);
    middle.kind = "TAMPERED";
    lines[1] = JSON.stringify(middle);
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const verify = await log.verifyChain();
    expect(verify.ok).toBe(false);
    expect(verify.brokenAtLine).toBe(2);
  });
});

describe("audit log redaction", () => {
  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactSecrets({ msg: `header ${jwt} trailer` });
    expect((out as any).msg).not.toContain(jwt);
    expect((out as any).msg).toContain("<redacted>");
  });

  it("redacts Slack tokens", () => {
    const tok = "xoxb-1234567890-abcdefghij-ABCDEFGHIJKLMNOPQRSTUVWX";
    const out = redactSecrets({ note: tok });
    // `note` isn't on the key-name list, so the value-side regex must catch it.
    expect((out as any).note).not.toContain(tok);
    expect((out as any).note).toContain("<redacted>");
  });

  it("redacts GitHub tokens", () => {
    const tok = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactSecrets({ note: `value=${tok}` });
    expect((out as any).note).not.toContain(tok);
  });

  it("redacts OpenAI sk- keys", () => {
    const tok = "sk-abcdefghijklmnopqrstuvwxyz1234";
    const out = redactSecrets({ note: tok });
    expect((out as any).note).not.toContain(tok);
  });

  it("redacts Anthropic sk-ant- keys (and not as plain sk-)", () => {
    const tok = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
    const out = redactSecrets({ note: tok });
    expect((out as any).note).not.toContain(tok);
    expect((out as any).note).toContain("<redacted>");
  });

  it("redacts AWS access keys", () => {
    const tok = "AKIAIOSFODNN7EXAMPLE";
    const out = redactSecrets({ note: `aws=${tok}` });
    expect((out as any).note).not.toContain(tok);
  });

  it("redacts GCP API keys", () => {
    const tok = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789a";
    const out = redactSecrets({ note: tok });
    expect((out as any).note).not.toContain(tok);
  });

  it("redacts PEM private key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAvbfake",
      "verysecretpayload",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets({ note: pem });
    expect((out as any).note).toContain("<redacted>");
    expect((out as any).note).not.toContain("verysecretpayload");
  });

  it("does NOT redact UUIDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const out = redactSecrets({ note: `id=${uuid}` });
    expect((out as any).note).toContain(uuid);
  });

  it("does NOT redact git SHAs", () => {
    const sha = "5d41402abc4b2a76b9719d911017c592a8b9d3e6"; // 40-char hex
    const out = redactSecrets({ note: `commit=${sha}` });
    expect((out as any).note).toContain(sha);
  });

  it("does NOT redact 32+ alnum content hashes (low entropy)", () => {
    // 40 char hex content hash — entropy ~4 bits/char, well below the 4.5 gate.
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    const out = redactSecrets({ note: hash });
    expect((out as any).note).toContain(hash);
  });

  it("key-name regex is word-bounded (does NOT redact 'keynote')", () => {
    const out = redactSecrets({ keynote: "the talk title" });
    // 'keynote' is not 'key' as a whole word, so the value should be intact.
    expect((out as any).keynote).toBe("the talk title");
  });

  it("shannonEntropy gives ~0 for repeats and >4 for high-entropy strings", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("0123456789abcdef")).toBeCloseTo(4, 0);
    // Random-ish base64
    expect(shannonEntropy("aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP+/=L"))
      .toBeGreaterThan(4.5);
  });
});
