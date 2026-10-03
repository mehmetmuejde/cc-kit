import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildClaudeMd, buildSettings } from "./compose.mjs";
import { key } from "./scan.mjs";
import { saveState, statePath } from "./state.mjs";

// Folders whose content cc-kit owns completely, minus the protected entries.
const MANAGED_DIRS = ["skills", "agents", "commands", "hooks"];
const PROTECTED = ["skills/synced", "skills/.trash"];
const KEEP_BACKUPS = 10;

const DEST = {
  skills: (it) => path.join("skills", it.id),
  agents: (it) => path.join("agents", `${it.id}.md`),
  commands: (it) => path.join("commands", `${it.id}.md`),
  hooks: (it) => path.join("hooks", it.id),
};

export function backupDirFor(target) {
  return `${target}.cc-kit-backups`;
}

export function managedEntries(target) {
  const entries = [];
  for (const dir of MANAGED_DIRS) {
    const abs = path.join(target, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (!PROTECTED.includes(rel)) entries.push(rel);
    }
  }
  if (fs.existsSync(path.join(target, "CLAUDE.md"))) entries.push("CLAUDE.md");
  return entries;
}

function createBackup(target, backupDir) {
  const items = [...MANAGED_DIRS, "CLAUDE.md", "settings.json", ".cc-kit"].filter((i) =>
    fs.existsSync(path.join(target, i)),
  );
  if (!items.length) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", target, ...items]);

  const old = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) fs.rmSync(path.join(backupDir, f));
  return file;
}

function copyItem(repoDir, target, item) {
  const destRoot = DEST[item.type](item);
  const srcRoot = item.type === "skills" || item.type === "hooks" ? path.join(item.type, item.id) : item.files[0];
  for (const rel of item.files) {
    const to = path.join(target, destRoot, path.relative(srcRoot, rel));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(repoDir, rel), to);
    if (item.type === "hooks") fs.chmodSync(to, fs.statSync(path.join(repoDir, rel)).mode);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Writes the selection into the target folder. Everything cc-kit manages is
// replaced; runtime data and protected folders are never touched.
export function install({ repoDir, repo, target, selection, allow, deny, meta, backupDir = backupDirFor(target) }) {
  fs.mkdirSync(target, { recursive: true });
  const backup = createBackup(target, backupDir);

  for (const rel of managedEntries(target)) fs.rmSync(path.join(target, rel), { recursive: true, force: true });

  const byType = (type) => selection.filter((it) => it.type === type);
  for (const type of Object.keys(DEST)) for (const it of byType(type)) copyItem(repoDir, target, it);

  const claudeMd = buildClaudeMd(byType("claudeMd"));
  if (claudeMd) fs.writeFileSync(path.join(target, "CLAUDE.md"), claudeMd);

  const settingsFile = path.join(target, "settings.json");
  const settings = buildSettings({
    existing: readJson(settingsFile),
    base: repo.base,
    hooks: byType("hooks"),
    allow,
    deny,
    targetDir: meta.targetForCommands ?? target,
  });
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  const hashes = Object.fromEntries(repo.items.map((it) => [key(it), it.hash]));
  if (repo.baseHash) hashes["settings/base"] = repo.baseHash;
  saveState(target, {
    repoUrl: meta.repoUrl,
    commit: meta.commit,
    installedAt: new Date().toISOString(),
    selection: selection.map(key),
    allow: allow.map((s) => s.id),
    deny: deny.map((s) => s.id),
    hashes,
  });

  return { backup, state: statePath(target), counts: countByType(selection) };
}

export function countByType(selection) {
  const counts = {};
  for (const it of selection) counts[it.type] = (counts[it.type] ?? 0) + 1;
  return counts;
}
