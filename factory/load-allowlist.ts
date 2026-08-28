import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiPolicy, AllowlistedRepo, SandboxKind, Wave } from "./types.ts";

export interface AllowlistCaps {
  in_flight: number;
  first_human_freezes: number;
  halt_merge_rate: number;
  halt_after_opens: number;
}

export interface ParsedAllowlist {
  version: number;
  caps: AllowlistCaps;
  denylist: { id: string; reason: string }[];
  repos: AllowlistedRepo[];
}

const REQUIRED_DENY = [
  "matplotlib/matplotlib",
  "curl/curl",
  "pydantic/pydantic",
  "stablyai/orca",
];

export function allowlistPath(from = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..", "allowlist.yaml");
}

export function loadAllowlistFile(path = allowlistPath()): ParsedAllowlist {
  return parseAllowlistYaml(readFileSync(path, "utf8"));
}

export function parseAllowlistYaml(text: string): ParsedAllowlist {
  const raw = parseYamlSubset(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("allowlist.yaml: expected a mapping");
  const version = Number(raw.version);
  if (version !== 2) throw new Error(`allowlist.yaml: unsupported version ${raw.version}`);

  const capsRaw = (raw.caps ?? {}) as Record<string, unknown>;
  const caps: AllowlistCaps = {
    in_flight: Number(capsRaw.in_flight),
    first_human_freezes: Number(capsRaw.first_human_freezes),
    halt_merge_rate: Number(capsRaw.halt_merge_rate),
    halt_after_opens: Number(capsRaw.halt_after_opens),
  };
  if (![caps.in_flight, caps.first_human_freezes, caps.halt_merge_rate, caps.halt_after_opens].every((n) => Number.isFinite(n))) {
    throw new Error("allowlist.yaml: caps must be numeric");
  }

  const denylist = asArray(raw.denylist).map((row) => {
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "");
    const reason = String(r.reason ?? "");
    if (!id || !reason) throw new Error("allowlist.yaml: denylist entries need id and reason");
    return { id, reason };
  });

  const repos = asArray(raw.repos).map((row) => hydrateRepo(row as Record<string, unknown>));
  return { version, caps, denylist, repos };
}

export function assertAllowlist(parsed: ParsedAllowlist): void {
  const denyIds = new Set(parsed.denylist.map((d) => d.id));
  for (const id of REQUIRED_DENY) {
    if (!denyIds.has(id)) throw new Error(`allowlist.yaml: denylist missing ${id}`);
  }
  const repoIds = new Set<string>();
  for (const repo of parsed.repos) {
    if (denyIds.has(repo.id)) throw new Error(`allowlist.yaml: denylist id leaked into repos: ${repo.id}`);
    if (repoIds.has(repo.id)) throw new Error(`allowlist.yaml: duplicate repo ${repo.id}`);
    repoIds.add(repo.id);
    if (repo.wave === 1 && repo.sandbox === "host") {
      throw new Error(`allowlist.yaml: Wave 1+ repo ${repo.id} must not use host sandbox`);
    }
  }
}

function hydrateRepo(r: Record<string, unknown>): AllowlistedRepo {
  const id = String(r.id ?? "");
  const parts = id.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`allowlist.yaml: invalid repo id ${id}`);
  }
  const wave = Number(r.wave) as Wave;
  if (wave !== 0 && wave !== 1 && wave !== 2) throw new Error(`allowlist.yaml: ${id} bad wave`);
  const aiPolicy = String(r.aiPolicy) as AiPolicy;
  const allowedPolicy: AiPolicy[] = ["owner", "welcome", "human-required", "unknown", "forbidden"];
  if (!allowedPolicy.includes(aiPolicy)) throw new Error(`allowlist.yaml: ${id} bad aiPolicy`);
  const sandbox = String(r.sandbox) as SandboxKind;
  if (sandbox !== "host" && sandbox !== "e2b" && sandbox !== "daytona") {
    throw new Error(`allowlist.yaml: ${id} bad sandbox`);
  }
  const maxFiles = Number(r.maxFiles);
  const maxDiffLines = Number(r.maxDiffLines);
  if (!Number.isFinite(maxFiles) || !Number.isFinite(maxDiffLines)) {
    throw new Error(`allowlist.yaml: ${id} needs maxFiles and maxDiffLines`);
  }
  const testCommand = String(r.testCommand ?? "");
  if (!testCommand) throw new Error(`allowlist.yaml: ${id} needs testCommand`);
  const preferredLabels = asArray(r.preferredLabels).map((x) => String(x));
  const firstIssues = asArray(r.firstIssues).map((row) => {
    const i = row as Record<string, unknown>;
    const number = Number(i.number);
    const title = String(i.title ?? "");
    const url = String(i.url ?? "");
    if (!Number.isInteger(number) || number < 1 || !title || !url) {
      throw new Error(`allowlist.yaml: ${id} firstIssues entry is incomplete`);
    }
    return { number, title, url };
  });
  return {
    id,
    owner: parts[0],
    name: parts[1],
    wave,
    language: String(r.language ?? ""),
    aiPolicy,
    policyNotes: String(r.policyNotes ?? ""),
    testCommand,
    maxFiles,
    maxDiffLines,
    sandbox,
    preferredLabels,
    firstIssues,
  };
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  throw new Error("allowlist.yaml: expected a sequence");
}

/** Minimal YAML subset: comments, mappings, sequences, flow sequences, scalars. */
export function parseYamlSubset(text: string): unknown {
  const lines = text.split(/\r?\n/).map((line, idx) => {
    const trimmed = stripComment(line);
    const indent = trimmed.length === 0 ? 0 : line.match(/^ */)?.[0].length ?? 0;
    return { n: idx + 1, indent, text: trimmed.trimEnd().trimStart() === "" ? "" : trimmed.trimEnd() };
  });
  const body = lines.filter((l) => l.text.trim() !== "");
  let i = 0;

  function peek() {
    return body[i];
  }
  function atEnd() {
    return i >= body.length;
  }

  function parseValue(minIndent: number): unknown {
    const line = peek();
    if (!line) return null;
    const t = line.text.trim();
    if (t.startsWith("- ")) return parseSeq(minIndent);
    if (t.includes(":")) return parseMap(minIndent);
    i += 1;
    return parseScalar(t);
  }

  function parseMap(minIndent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (!atEnd()) {
      const line = peek();
      if (line.indent < minIndent) break;
      if (line.text.trim().startsWith("- ")) break;
      if (line.indent !== minIndent && Object.keys(map).length) break;
      const trimmed = line.text.trim();
      const colon = splitKey(trimmed);
      if (!colon) throw new Error(`allowlist.yaml:${line.n}: expected key:`);
      i += 1;
      const { key, rest } = colon;
      if (rest !== "") {
        map[key] = parseScalar(rest);
        continue;
      }
      const next = peek();
      if (!next || next.indent <= line.indent) {
        map[key] = null;
        continue;
      }
      map[key] = parseValue(next.indent);
    }
    return map;
  }

  function parseSeq(minIndent: number): unknown[] {
    const seq: unknown[] = [];
    while (!atEnd()) {
      const line = peek();
      if (line.indent < minIndent) break;
      const trimmed = line.text.trim();
      if (!trimmed.startsWith("- ")) break;
      if (line.indent !== minIndent && seq.length) break;
      const rest = trimmed.slice(2);
      i += 1;
      if (rest === "") {
        const next = peek();
        seq.push(next ? parseValue(next.indent) : null);
        continue;
      }
      if (rest.includes(":") && !rest.startsWith("[") && !looksLikeFlow(rest)) {
        const colon = splitKey(rest);
        if (!colon) {
          seq.push(parseScalar(rest));
          continue;
        }
        const item: Record<string, unknown> = {};
        if (colon.rest !== "") item[colon.key] = parseScalar(colon.rest);
        else {
          const next = peek();
          item[colon.key] = next && next.indent > line.indent ? parseValue(next.indent) : null;
        }
        while (!atEnd()) {
          const n = peek();
          if (n.indent <= line.indent) break;
          if (n.text.trim().startsWith("- ")) break;
          const inner = splitKey(n.text.trim());
          if (!inner) break;
          i += 1;
          if (inner.rest !== "") item[inner.key] = parseScalar(inner.rest);
          else {
            const next = peek();
            item[inner.key] = next && next.indent > n.indent ? parseValue(next.indent) : null;
          }
        }
        seq.push(item);
        continue;
      }
      seq.push(parseScalar(rest));
    }
    return seq;
  }

  const first = peek();
  if (!first) return {};
  return parseValue(first.indent);
}

function looksLikeFlow(s: string): boolean {
  return s.startsWith("[") || s.startsWith("{") || s.startsWith('"') || s.startsWith("'");
}

function splitKey(trimmed: string): { key: string; rest: string } | null {
  const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
  if (!m) return null;
  return { key: m[1], rest: m[2] };
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[") && s.endsWith("]")) return parseFlowSeq(s.slice(1, -1));
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function parseFlowSeq(inner: string): unknown[] {
  const out: unknown[] = [];
  let buf = "";
  let q: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) {
      if (ch === q) q = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (ch === ",") {
      out.push(parseScalar(buf));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") out.push(parseScalar(buf));
  return out;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}
