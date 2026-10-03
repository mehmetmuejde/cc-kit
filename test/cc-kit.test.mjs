import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeMd, buildSettings } from "../src/compose.mjs";
import { ensureLine } from "../src/gitignore.mjs";
import { install } from "../src/install.mjs";
import { validateRepoUrl } from "../src/repo.mjs";
import { key, parseFrontmatter, scanRepo } from "../src/scan.mjs";
import { diffItems, loadState } from "../src/state.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cc-kit.mjs");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cc-kit-${prefix}-`));
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function git(dir, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdio: "ignore" });
}

// A small content repo in cc-kit layout, committed to a fresh git repo.
function fixtureRepo() {
  const root = tmp("repo");
  write(root, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Use when: testing alpha\n---\nAlpha\n");
  write(root, "skills/alpha/extra/notes.md", "notes\n");
  write(root, "skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta skill\ndefault: false\n---\nBeta\n");
  write(root, "skills/_draft/SKILL.md", "---\nname: draft\n---\n");
  write(root, "agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews\n---\n");
  write(root, "commands/hello.md", "Hello\n");
  write(root, "hooks/guard/hook.yaml", 'description: "Guard: blocks"\nevent: PreToolUse\nmatcher: Bash\nif: "Bash(git commit*)"\ncommand: python3 {{dir}}/guard.py\n');
  write(root, "hooks/guard/guard.py", "print('ok')\n");
  write(root, "hooks/notify/hook.yaml", "description: Notify\ndefault: false\nevent: Stop\ncommand: python3 {{dir}}/notify.py\n");
  write(root, "hooks/notify/notify.py", "print('n')\n");
  write(root, "claude-md/00-kopf.md", "---\ntitle: Kopf\nrequired: true\n---\n\n# Regeln\n");
  write(root, "claude-md/10-stil.md", "---\ntitle: Stil\ndescription: Kurz antworten\n---\n\n## Stil\n\nKurz.\n");
  write(root, "claude-md/20-extra.md", "---\ntitle: Extra\ndefault: false\n---\n\n## Extra\n");
  write(root, "settings/base.yaml", "model: opus\nattribution:\n  commit: \"\"\n");
  write(root, "settings/permissions/tools.yaml", "description: Tools\ndefault: allow\nrules:\n  - Edit\n  - Write\n");
  write(root, "settings/permissions/root.yaml", "description: Root\ndefault: deny\nrules:\n  - Bash(sudo*)\n");
  write(root, "settings/permissions/kube.yaml", "description: Kube\nrules:\n  - Bash(kubectl apply:*)\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("rejects credentials in https urls", () => {
  assert.match(validateRepoUrl("https://user:token@github.com/a/b.git"), /Zugangsdaten/);
  assert.equal(validateRepoUrl("ssh://git@host:2222/a/b.git"), null);
  assert.equal(validateRepoUrl("https://github.com/a/b.git"), null);
});

test("frontmatter falls back to loose parsing for unquoted colons", () => {
  const { data, body } = parseFrontmatter("---\nname: x\ndescription: Use when: things\n---\nBody\n");
  assert.equal(data.description, "Use when: things");
  assert.equal(body, "Body\n");
});

test("scan finds all item types and skips _ and . entries", () => {
  const repo = scanRepo(fixtureRepo());
  const ids = repo.items.map(key).sort();
  assert.deepEqual(ids, [
    "agents/reviewer",
    "claudeMd/00-kopf",
    "claudeMd/10-stil",
    "claudeMd/20-extra",
    "commands/hello",
    "hooks/guard",
    "hooks/notify",
    "permissions/kube",
    "permissions/root",
    "permissions/tools",
    "skills/alpha",
    "skills/beta",
  ]);
  const alpha = repo.items.find((i) => i.id === "alpha");
  assert.equal(alpha.files.length, 2);
  assert.equal(repo.items.find((i) => i.id === "beta").default, false);
  assert.equal(repo.items.find((i) => i.id === "kube").mode, "ask");
  assert.equal(repo.items.find((i) => i.id === "00-kopf").required, true);
});

test("base.yaml must not contain hooks or permissions", () => {
  const root = fixtureRepo();
  write(root, "settings/base.yaml", "hooks: {}\n");
  assert.throws(() => scanRepo(root), /gehört nicht hierher/);
});

test("CLAUDE.md is assembled in file order without frontmatter", () => {
  const repo = scanRepo(fixtureRepo());
  const md = buildClaudeMd(repo.items.filter((i) => i.type === "claudeMd" && i.id !== "20-extra"));
  assert.equal(md, "# Regeln\n\n## Stil\n\nKurz.\n");
});

test("settings keep foreign keys and replace managed ones", () => {
  const repo = scanRepo(fixtureRepo());
  const sets = repo.items.filter((i) => i.type === "permissions");
  const settings = buildSettings({
    existing: {
      statusLine: { type: "command", command: "ccstatusline" },
      theme: "dark",
      model: "sonnet",
      permissions: { allow: ["Old"], defaultMode: "acceptEdits" },
      hooks: { Old: [] },
    },
    base: repo.base,
    hooks: repo.items.filter((i) => i.id === "guard"),
    allow: sets.filter((s) => s.id === "tools"),
    deny: sets.filter((s) => s.id === "root"),
    targetDir: "~/.claude",
  });
  assert.deepEqual(settings.statusLine, { type: "command", command: "ccstatusline" });
  assert.equal(settings.theme, "dark");
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.permissions, { allow: ["Edit", "Write"], deny: ["Bash(sudo*)"], defaultMode: "acceptEdits" });
  assert.deepEqual(settings.hooks, {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "python3 ~/.claude/hooks/guard/guard.py", if: "Bash(git commit*)" }],
      },
    ],
  });
});

test("diff reports added, changed and removed items", () => {
  const items = [
    { type: "skills", id: "a", hash: "1" },
    { type: "skills", id: "b", hash: "9" },
  ];
  const diff = diffItems({ "skills/b": "2", "skills/c": "3" }, items);
  assert.deepEqual(diff, { added: ["skills/a"], changed: ["skills/b"], removed: ["skills/c"] });
});

test("install replaces managed content and leaves runtime data alone", () => {
  const repoDir = fixtureRepo();
  const repo = scanRepo(repoDir);
  const target = path.join(tmp("target"), ".claude");
  write(target, "skills/old/SKILL.md", "old");
  write(target, "skills/synced/web/SKILL.md", "web");
  write(target, "projects/p/memory/x.md", "mem");
  write(target, "claude.json", "{}");
  write(target, "settings.json", JSON.stringify({ statusLine: { command: "ccstatusline" } }));

  const selection = repo.items.filter((i) => i.default && i.type !== "permissions");
  const sets = repo.items.filter((i) => i.type === "permissions");
  const result = install({
    repoDir,
    repo,
    target,
    selection,
    allow: sets.filter((s) => s.mode === "allow"),
    deny: sets.filter((s) => s.mode === "deny"),
    meta: { repoUrl: repoDir, commit: "abc", targetForCommands: target },
  });

  const has = (rel) => fs.existsSync(path.join(target, rel));
  assert.ok(!has("skills/old"));
  assert.ok(has("skills/synced/web/SKILL.md"));
  assert.ok(has("projects/p/memory/x.md"));
  assert.ok(has("claude.json"));
  assert.ok(has("skills/alpha/extra/notes.md"));
  assert.ok(!has("skills/beta"));
  assert.ok(has("hooks/guard/guard.py"));
  assert.ok(!has("hooks/notify"));
  assert.ok(has("agents/reviewer.md"));
  assert.ok(has("commands/hello.md"));
  assert.equal(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"), "# Regeln\n\n## Stil\n\nKurz.\n");

  const settings = JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8"));
  assert.deepEqual(settings.statusLine, { command: "ccstatusline" });
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `python3 ${target}/hooks/guard/guard.py`);

  assert.ok(result.backup && fs.existsSync(result.backup));
  const state = loadState(target);
  assert.equal(state.commit, "abc");
  assert.deepEqual(state.allow, ["tools"]);
  assert.ok(state.selection.includes("skills/alpha"));
});

test("global ignore line is added once", () => {
  const file = path.join(tmp("ignore"), "git", "ignore");
  assert.equal(ensureLine(file, ".scratch/", "notes"), true);
  assert.equal(ensureLine(file, ".scratch/", "notes"), false);
  assert.equal(fs.readFileSync(file, "utf8"), "# notes\n.scratch/\n");
});

function runCli(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

test("cli update installs from a repo and detects changes on the next run", () => {
  const repoDir = fixtureRepo();
  const home = tmp("home");
  const target = path.join(home, ".claude");

  const first = runCli(["update", "--repo", repoDir], home);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.ok(fs.existsSync(path.join(target, "skills/alpha/SKILL.md")));
  const settings = JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "python3 ~/.claude/hooks/guard/guard.py");

  write(repoDir, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: changed\n---\n");
  write(repoDir, "skills/gamma/SKILL.md", "---\nname: gamma\n---\n");
  fs.rmSync(path.join(repoDir, "commands/hello.md"));
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "change");

  const second = runCli(["update"], home);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /neu:\s+skills\/gamma/);
  assert.match(second.stdout, /geändert:\s+skills\/alpha/);
  assert.match(second.stdout, /entfernt:\s+commands\/hello/);
  assert.ok(!fs.existsSync(path.join(target, "commands/hello.md")));
  assert.ok(!fs.existsSync(path.join(target, "skills/gamma")), "new items are not auto-selected");
  assert.match(fs.readFileSync(path.join(target, "skills/alpha/SKILL.md"), "utf8"), /changed/);
});

test("cli update without any repo fails with a hint", () => {
  const home = tmp("home");
  const run = runCli(["update"], home);
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /npx cc-kit/);
});
