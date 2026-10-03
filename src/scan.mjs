import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const TYPES = ["skills", "hooks", "agents", "commands", "claudeMd", "permissions"];

const ignored = (name) => name.startsWith(".") || name.startsWith("_");

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !ignored(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walkFiles(root, rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isFile()) return [rel];
  return listDir(abs).flatMap((e) => walkFiles(root, path.join(rel, e.name)));
}

function hashFiles(root, files) {
  const hash = crypto.createHash("sha256");
  for (const rel of [...files].sort()) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  let data;
  try {
    data = YAML.parse(match[1]) ?? {};
  } catch {
    data = parseLoose(match[1]);
  }
  return { data, body: text.slice(match[0].length) };
}

// Claude Code accepts unquoted values containing ": " in frontmatter; strict YAML
// does not. Fall back to one "key: value" per line, value taken verbatim.
function parseLoose(block) {
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    data[m[1]] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return data;
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    throw new Error(`${file}: ungültiges YAML (${err.message.split("\n")[0]})`);
  }
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function item(root, type, id, files, meta) {
  return {
    type,
    id,
    label: meta.label ?? id,
    description: oneLine(meta.description),
    default: meta.default !== false,
    files,
    hash: hashFiles(root, files),
    ...meta.extra,
  };
}

function scanSkills(root) {
  return listDir(path.join(root, "skills"))
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, "skills", e.name, "SKILL.md")))
    .map((e) => {
      const rel = path.join("skills", e.name);
      const { data } = parseFrontmatter(fs.readFileSync(path.join(root, rel, "SKILL.md"), "utf8"));
      return item(root, "skills", e.name, walkFiles(root, rel), {
        label: data.name ?? e.name,
        description: data.description,
        default: data.default,
      });
    });
}

function scanMarkdownFiles(root, type, folder) {
  return listDir(path.join(root, folder))
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => {
      const rel = path.join(folder, e.name);
      const { data } = parseFrontmatter(fs.readFileSync(path.join(root, rel), "utf8"));
      const id = e.name.replace(/\.md$/, "");
      return item(root, type, id, [rel], { label: data.name ?? id, description: data.description, default: data.default });
    });
}

function scanHooks(root) {
  return listDir(path.join(root, "hooks"))
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, "hooks", e.name, "hook.yaml")))
    .map((e) => {
      const rel = path.join("hooks", e.name);
      const spec = readYaml(path.join(root, rel, "hook.yaml"));
      for (const key of ["event", "command"]) {
        if (!spec[key]) throw new Error(`${rel}/hook.yaml: "${key}" fehlt`);
      }
      return item(root, "hooks", e.name, walkFiles(root, rel).filter((f) => !f.endsWith("hook.yaml")), {
        description: spec.description,
        default: spec.default,
        extra: { hook: { event: spec.event, matcher: spec.matcher, if: spec.if, command: spec.command, timeout: spec.timeout } },
      });
    });
}

function scanClaudeMd(root) {
  return listDir(path.join(root, "claude-md"))
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => {
      const rel = path.join("claude-md", e.name);
      const { data, body } = parseFrontmatter(fs.readFileSync(path.join(root, rel), "utf8"));
      const id = e.name.replace(/\.md$/, "");
      return item(root, "claudeMd", id, [rel], {
        label: data.title ?? id.replace(/^\d+-/, ""),
        description: data.description,
        default: data.default,
        extra: { required: data.required === true, body: body.trim() },
      });
    });
}

function scanPermissions(root) {
  const folder = path.join("settings", "permissions");
  return listDir(path.join(root, folder))
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => {
      const rel = path.join(folder, e.name);
      const spec = readYaml(path.join(root, rel));
      const rules = Array.isArray(spec.rules) ? spec.rules.map(String) : [];
      if (!rules.length) throw new Error(`${rel}: "rules" fehlt oder ist leer`);
      const mode = ["allow", "ask", "deny"].includes(spec.default) ? spec.default : "ask";
      return item(root, "permissions", e.name.replace(/\.ya?ml$/, ""), [rel], {
        description: spec.description,
        default: true,
        extra: { rules, mode },
      });
    });
}

// Reads the whole repo into a list of installable items plus shared settings.
export function scanRepo(root) {
  const meta = fs.existsSync(path.join(root, "cc-kit.yaml")) ? readYaml(path.join(root, "cc-kit.yaml")) : {};
  const baseFile = path.join(root, "settings", "base.yaml");
  const base = fs.existsSync(baseFile) ? readYaml(baseFile) : {};
  for (const key of ["hooks", "permissions"]) {
    if (key in base) throw new Error(`settings/base.yaml: "${key}" gehört nicht hierher, siehe hooks/ und settings/permissions/`);
  }

  const items = [
    ...scanSkills(root),
    ...scanHooks(root),
    ...scanMarkdownFiles(root, "agents", "agents"),
    ...scanMarkdownFiles(root, "commands", "commands"),
    ...scanClaudeMd(root),
    ...scanPermissions(root),
  ];
  return {
    name: meta.name ?? "cc-kit",
    base,
    baseHash: fs.existsSync(baseFile) ? hashFiles(root, [path.join("settings", "base.yaml")]) : null,
    items,
  };
}

export const key = (it) => `${it.type}/${it.id}`;
