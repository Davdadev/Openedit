// Validates the Claude Code plugin packaging: skills/*/SKILL.md frontmatter and links,
// .claude-plugin/plugin.json, .claude-plugin/marketplace.json and the MCP launcher.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

interface Frontmatter {
  raw: Record<string, string>;
  body: string;
}

/** Minimal parser for the single-line `key: value` frontmatter skills use (no nested YAML). */
function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no YAML frontmatter delimited by --- lines");
  const raw: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (!kv) throw new Error(`unparseable frontmatter line: ${line}`);
    raw[kv[1]] = kv[2];
  }
  return { raw, body: m[2] };
}

/** The value as YAML would read it; rejects plain scalars YAML would misparse. */
function scalar(key: string, v: string): string {
  if (/^".*"$/.test(v)) return JSON.parse(v) as string;
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^[\s>|&*!%@`#{[\]},?-]/.test(v)) throw new Error(`${key}: plain scalar starts with a YAML indicator; quote it`);
  if (/:\s/.test(v)) throw new Error(`${key}: plain scalar contains ": "; quote it or rephrase`);
  if (/\s#/.test(v)) throw new Error(`${key}: plain scalar contains " #" (YAML comment); quote it`);
  return v.trim();
}

/** Relative file links in markdown: [text](path) and backticked references/*.md mentions. */
function localRefs(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    out.add(target);
  }
  for (const m of markdown.matchAll(/`((?:references|scripts|assets)\/[\w./-]+)`/g)) out.add(m[1]);
  return [...out];
}

const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())
  : [];

describe("skills", () => {
  it("has the expected skill set", () => {
    expect(skills.sort()).toEqual(
      [
        "openedit-editing",
        "openedit-premiere-computer-use",
        "openedit-resolve-computer-use",
        "openedit-review",
        "openedit-shorts",
        "openedit-stock-media",
      ].sort(),
    );
  });

  describe.each(skills)("%s", (name) => {
    const dir = join(skillsDir, name);
    const file = join(dir, "SKILL.md");

    it("has a SKILL.md with valid frontmatter", () => {
      expect(existsSync(file)).toBe(true);
      const { raw, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
      for (const k of Object.keys(raw)) expect(allowed.has(k), `unexpected frontmatter key ${k}`).toBe(true);

      const n = scalar("name", raw.name ?? "");
      expect(n).toBe(name);
      expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(n.length).toBeLessThanOrEqual(64);

      const d = scalar("description", raw.description ?? "");
      expect(d.length).toBeGreaterThan(80);
      expect(d.length).toBeLessThan(1024);
      expect(d).not.toMatch(/[<>]/);

      expect(body.trim().length).toBeGreaterThan(200);
      expect(body.split("\n").length, "keep SKILL.md bodies tight; move detail to references/").toBeLessThanOrEqual(250);
    });

    it("only links to files that exist", () => {
      const docs = [file];
      const refDir = join(dir, "references");
      if (existsSync(refDir)) for (const f of readdirSync(refDir)) docs.push(join(refDir, f));
      for (const doc of docs) {
        for (const ref of localRefs(readFileSync(doc, "utf8"))) {
          const fromDoc = resolve(dirname(doc), ref);
          const fromSkill = resolve(dir, ref);
          expect(existsSync(fromDoc) || existsSync(fromSkill), `${doc} links to missing ${ref}`).toBe(true);
          expect(fromDoc.startsWith(dir) || fromSkill.startsWith(dir), `${doc} links outside its skill: ${ref}`).toBe(true);
        }
      }
    });

    it("contains exactly one SKILL.md", () => {
      const found: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) walk(p);
          else if (e === "SKILL.md") found.push(p);
        }
      };
      walk(dir);
      expect(found).toEqual([file]);
    });
  });
});

describe("plugin packaging", () => {
  const plugin = readJson(".claude-plugin/plugin.json");

  it("plugin.json has the required metadata", () => {
    expect(plugin.name).toBe("openedit");
    expect(plugin.version).toBe(readJson("package.json").version);
    expect(plugin.license).toBe("GPL-2.0-only");
    expect(plugin.author?.name).toBe("Davdadev");
    expect(plugin.repository).toBe("https://github.com/Davdadev/openedit");
    expect(() => new URL(plugin.homepage)).not.toThrow();
    expect(typeof plugin.description).toBe("string");
  });

  it("registers the MCP server through a launcher that exists and parses", () => {
    const servers = plugin.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(Object.keys(servers)).toEqual(["openedit"]);
    const { command, args } = servers.openedit;
    expect(command).toBe("node");
    expect(args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/openedit-mcp.mjs");
    const launcher = args[0].replace("${CLAUDE_PLUGIN_ROOT}", root);
    expect(existsSync(launcher)).toBe(true);
    execFileSync(process.execPath, ["--check", launcher]);
  });

  it("keeps plugin files out of a top-level bin/ (claude.ai and Cowork refuse such plugins)", () => {
    expect(existsSync(join(root, "bin"))).toBe(false);
  });

  it("does not ship a root .mcp.json that would become a broken project-scope server", () => {
    // A root .mcp.json is also read as the project's MCP config when Claude Code runs in this
    // repo, where ${CLAUDE_PLUGIN_ROOT} is not defined. The plugin declares its server inline.
    const p = join(root, ".mcp.json");
    if (!existsSync(p)) return;
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(JSON.stringify(cfg)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("marketplace.json lists this plugin from the repo root", () => {
    const mk = readJson(".claude-plugin/marketplace.json");
    expect(mk.name).toMatch(/^[A-Za-z0-9][\w.-]*$/);
    expect(mk.owner?.name).toBeTruthy();
    const entry = (mk.plugins as { name: string; source: string }[]).find((p) => p.name === plugin.name);
    expect(entry).toBeTruthy();
    expect(entry!.source).toMatch(/^\.\/?/);
    expect(existsSync(join(root, entry!.source, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(root, entry!.source, "skills"))).toBe(true);
  });
});
