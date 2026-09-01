// Verification harness — the master plan's Verification section, item (a):
// "a scratch zod script validates schema examples." Extended here to do the
// strongest version of that: validate the REAL corpus and probe files against
// the REAL reference schemas, not just synthetic examples — because at
// spec-stage the corpus IS the codebase, and design-report line "every canon
// file in-repo validates (corpus lint IS a test)" is already in force.
//
// Run: npx tsx scripts/verify-schemas.ts   (from repo root)
// Exit 0 = all green; exit 1 = any unexpected failure.

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

import {
  CanonFrontmatter,
  AFFECT_DIMS,
} from "../schemas/exemplar.ts";
import { EventEnvelope } from "../schemas/events.ts";
import { DecisionObject } from "../schemas/decision.ts";
import { Appraisal } from "../schemas/appraisal.ts";
import { ProbeDef } from "../schemas/probe.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
let failures = 0;
let checks = 0;

function ok(cond: unknown, label: string, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const read = (p: string): string => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Compact one-line zod error: "path: message; path: message". */
function zodErr(e: any): string {
  const issues = e?.issues ?? [{ path: [], message: String(e?.message ?? e) }];
  return issues.map((i: any) => `${(i.path ?? []).join(".")}: ${i.message}`).slice(0, 6).join("; ");
}

function splitFrontmatter(text: string): { fm: unknown; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter block");
  return { fm: yaml.load(m[1]), body: m[2] };
}

function listFiles(dir: string, pred: (n: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), pred));
    else if (pred(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log("\n[1] registers.yaml vocabulary");
const registers = yaml.load(read(path.join(ROOT, "corpus/canon/registers.yaml"))) as {
  modes: Record<string, string>; modifiers: Record<string, string>;
};
const modes = Object.keys(registers.modes);
const modifiers = Object.keys(registers.modifiers);
ok(modes.length >= 3, `modes: ${modes.join(", ")}`);
ok(modifiers.length >= 5, `modifiers: ${modifiers.join(", ")}`);

// ---------------------------------------------------------------------------
console.log("\n[2] canon exemplars vs CanonFrontmatter (+ corpus lint)");
const canonFiles = listFiles(path.join(ROOT, "corpus/canon"), (n) => n.endsWith(".md") && n !== "TEMPLATE.md" && n !== "identity.md");
const canonIds = new Set<string>();
const frontmatters: Array<{ file: string; fm: any; body: string }> = [];

for (const f of canonFiles.sort()) {
  const rel = path.relative(ROOT, f).replaceAll("\\", "/");
  try {
    const { fm, body } = splitFrontmatter(read(f));
    const parsed = CanonFrontmatter.parse(fm);
    frontmatters.push({ file: rel, fm: parsed, body });
    canonIds.add(parsed.id);

    const words = body.split(/\s+/).filter(Boolean).length;
    const dimDir = rel.split("/")[2];
    const label = rel.replace("corpus/canon/", "");

    ok(parsed.id === `canon/${dimDir}/${path.basename(f, ".md")}`, `${label} id matches path`, parsed.id);
    ok(parsed.dimensions[0] === dimDir, `${label} primary dim = dir`);
    ok(modes.includes(parsed.register[0]), `${label} register mode '${parsed.register[0]}' in vocab`);
    ok(parsed.register.length <= 3 && parsed.register.slice(1).every((r: string) => modifiers.includes(r)),
      `${label} register modifiers in vocab`);
    ok(Object.keys(parsed.affect).every((k) => (AFFECT_DIMS as readonly string[]).includes(k)), `${label} affect keys in AFFECT_DIMS`);
    ok(words <= 500, `${label} token cap (~${words} words)`);
    if (words > 350) console.log(`  warn ${label} over 350-token warn line (~${words})`);

    const hasExchange = /^D:/m.test(body) && /^T:/m.test(body);
    if (parsed.kind === "scene") ok(hasExchange, `${label} scene has >= 1 D:/T: exchange`);
    if (parsed.kind === "procedure") {
      ok(hasExchange && /\[tool\]/.test(body) && /\[outcome\]/.test(body), `${label} procedure has D:/T: + [tool] + [outcome]`);
    }
    if (parsed.kind === "statement") ok(true, `${label} statement (bodyless prose allowed)`);
  } catch (e: any) {
    failures++;
    checks++;
    console.log(`  FAIL ${rel} — ${zodErr(e)}`);
  }
}
ok(canonFiles.length === 17, `17 DRAFT exemplars found (got ${canonFiles.length})`);

// counters resolve to real ids (foil-link integrity)
const allCounterRefs = frontmatters.flatMap((x) => x.fm.counters ?? []);
for (const c of allCounterRefs) ok(canonIds.has(c), `counter ref resolves: ${c}`);
ok(allCounterRefs.length > 0, "counter links exist at all");

// ---------------------------------------------------------------------------
console.log("\n[3] coupling.yaml compiles per M06 rules (strict)");
const coupling = yaml.load(read(path.join(ROOT, "coupling.yaml"))) as any;
ok(coupling.lambda === 0.25, `lambda = 0.25 (got ${coupling.lambda})`);
ok(Array.isArray(coupling.matrix) && coupling.matrix.length > 0, `matrix has entries (${coupling.matrix?.length})`);
for (const e of coupling.matrix ?? []) {
  ok((AFFECT_DIMS as readonly string[]).includes(e.from) && (AFFECT_DIMS as readonly string[]).includes(e.to),
    `matrix ${e.from}->${e.to} dims valid`);
  ok(typeof e.why === "string" && e.why.length > 0, `matrix ${e.from}->${e.to} has why (strict compile)`);
  ok(typeof e.w === "number", `matrix ${e.from}->${e.to} has w`);
}
for (const r of coupling.formRules ?? []) {
  ok((AFFECT_DIMS as readonly string[]).includes(r.when?.dim), `formRule dim ${r.when?.dim} valid`);
  ok(typeof r.boostTag === "string" && typeof r.gain === "number", `formRule ${r.boostTag} well-formed`);
}

// ---------------------------------------------------------------------------
console.log("\n[4] probe files vs ProbeDef (+ reference resolution)");
const fixtureKeys = new Set<string>();
for (const f of listFiles(path.join(ROOT, "probes/fixtures"), (n) => n.endsWith(".json"))) {
  const j = JSON.parse(read(f));
  for (const k of Object.keys(j)) fixtureKeys.add(k);
}
const probeFiles = listFiles(path.join(ROOT, "probes"), (n) => n.endsWith(".probe.yaml"));
ok(probeFiles.length === 3, `3 example probes found (got ${probeFiles.length})`);
for (const f of probeFiles.sort()) {
  const rel = path.relative(ROOT, f).replaceAll("\\", "/");
  try {
    const def = ProbeDef.parse(yaml.load(read(f)));
    ok(true, `${rel} parses`);
    for (const ep of def.fixtures.episodeSet) ok(fixtureKeys.has(ep), `${rel} episode fixture '${ep}' resolves`);
    const rubric = def.expect.judgeRubric;
    if (rubric) for (const ref of rubric.references) ok(canonIds.has(ref), `${rel} judge reference '${ref}' resolves`);
    if (rubric) ok(fs.existsSync(path.join(ROOT, "corpus", rubric.anchor)), `${rel} anchor '${rubric.anchor}' exists (corpus-relative)`);
  } catch (e: any) {
    failures++;
    checks++;
    console.log(`  FAIL ${rel} — ${zodErr(e)}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n[5] schema round-trips (documented examples)");
// EventEnvelope — valid
EventEnvelope.parse({ seq: 1, ts: 1_790_000_000_000, kind: "model.call", turnId: "t-17",
  payload: { taskClass: "turn", tier: "main", model: "x", usage: {}, outcome: "ok" } });
ok(true, "EventEnvelope accepts a valid envelope");
ok(!EventEnvelope.safeParse({ seq: 1, ts: 0, kind: "noDots", payload: {} }).success, "EventEnvelope rejects dotless kind");
ok(!EventEnvelope.safeParse({ seq: 0, ts: 0, kind: "a.ok", payload: {} }).success, "EventEnvelope rejects seq < 1");

// DecisionObject — valid (silent plan)
DecisionObject.parse({
  turnId: "t-17", plan: "silent", bubbles: [], confidence: 0.4, weight: 0.2,
  reluctance: 0.7, completeness: 0.5, toolTrace: [], spawns: [], inhibitions: [{ allow: true }],
});
ok(true, "DecisionObject accepts a silent-plan decision");
ok(!DecisionObject.safeParse({
  turnId: "t-17", plan: "reply", bubbles: [], confidence: 0.4, weight: 0.2, reluctance: 0.7,
  completeness: 0.5, toolTrace: [], spawns: [], inhibitions: [],
}).success === false, "DecisionObject accepts reply with bubbles");
ok(!DecisionObject.safeParse({ turnId: "t-17", plan: "gossip", bubbles: [], confidence: 0, weight: 0,
  reluctance: 0, completeness: 0, toolTrace: [], spawns: [], inhibitions: [] }).success, "DecisionObject rejects unknown plan");

// Appraisal — both outcomePrev shapes
Appraisal.parse({ importance: 4, emotions: [{ tag: "playfulness", i: 3, cause: "his typo" }],
  diaryLine: "he typo'd twice and blamed the keyboard", threads: [{ id: "thr-1", title: "keyboards", status: "touched" }],
  outcomePrev: null });
Appraisal.parse({ importance: 2, emotions: [], diaryLine: "quiet turn", threads: [],
  outcomePrev: { sign: 1, evidence: "he replied 'ok good' and continued the thread" } });
ok(true, "Appraisal accepts both outcomePrev shapes (null + graded)");
ok(!Appraisal.safeParse({ importance: 0, emotions: [], diaryLine: "x", threads: [], outcomePrev: null }).success,
  "Appraisal rejects importance 0");
ok(!Appraisal.safeParse({ importance: 2, emotions: [{ tag: "playfulness", i: 11, cause: "x" }], diaryLine: "x",
  threads: [], outcomePrev: null }).success, "Appraisal rejects i > 10");

// ---------------------------------------------------------------------------
console.log(`\n=== ${checks - failures}/${checks} checks green, ${failures} failed ===`);
process.exit(failures === 0 ? 0 : 1);
