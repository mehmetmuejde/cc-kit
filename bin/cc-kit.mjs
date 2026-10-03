#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { globalExcludesFile, ensureLine, hasLine } from "../src/gitignore.mjs";
import { backupDirFor, countByType, install, managedEntries } from "../src/install.mjs";
import { checkRemote, syncRepo, validateRepoUrl } from "../src/repo.mjs";
import { key, scanRepo } from "../src/scan.mjs";
import { diffItems, loadState } from "../src/state.mjs";

const HELP = `cc-kit — set up Claude Code from a Git repo

  npx cc-kit                 interactive; asks for the repo URL on the first run
  npx cc-kit update          latest repo state, same selection, no questions

Options
  --repo <url>     set or change the repo URL (SSH or HTTPS)
  --ref <branch>   use another branch or tag
  --target <dir>   target folder (default: ~/.claude)
  --dry-run        show what would happen, write nothing
  -h, --help       show this help
`;

const LABELS = {
  skills: "Skills",
  hooks: "Hooks",
  agents: "Agents",
  commands: "Commands",
  claudeMd: "CLAUDE.md sections",
};

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    ref: { type: "string" },
    target: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const command = positionals[0] ?? "setup";
if (!["setup", "update"].includes(command)) {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}
const unattended = command === "update";

const home = os.homedir();
const defaultTarget = path.join(home, ".claude");
const target = path.resolve((args.target ?? defaultTarget).replace(/^~(?=$|\/)/, home));
// Hook commands keep "~" for the default target so settings.json stays portable.
const targetForCommands = target === defaultTarget ? "~/.claude" : target;

function bail(message) {
  p.cancel(message);
  process.exit(1);
}

function guard(value) {
  if (p.isCancel(value)) bail("Cancelled. Nothing was changed.");
  return value;
}

function hint(item, diff) {
  const flag = diff.added.includes(key(item)) ? "new · " : diff.changed.includes(key(item)) ? "changed · " : "";
  const text = `${flag}${item.description}`;
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

async function askRepoUrl(previous) {
  if (args.repo) return args.repo;
  if (previous?.repoUrl) return previous.repoUrl;
  if (unattended) bail("No repo configured yet. Run `npx cc-kit` interactively first.");
  return guard(
    await p.text({
      message: "URL of your configuration repo (SSH or HTTPS)",
      placeholder: "ssh://git@git.example.com/you/claude-config.git",
      validate: validateRepoUrl,
    }),
  );
}

async function pickItems(type, items, preselected, diff) {
  const options = items.map((it) => ({ value: key(it), label: it.label, hint: hint(it, diff) }));
  const chosen = guard(
    await p.multiselect({
      message: `${LABELS[type]} (space to toggle, enter to confirm)`,
      options,
      initialValues: options.map((o) => o.value).filter((v) => preselected.has(v)),
      required: false,
    }),
  );
  return new Set(chosen);
}

async function main() {
  p.intro("cc-kit");
  const previous = loadState(target);

  if (fs.existsSync(path.join(target, ".git"))) {
    p.log.warn(`${target} is a git repo. cc-kit will overwrite managed files in it.`);
    if (unattended) bail("Cancelled: target folder is a git repo.");
    const go = guard(await p.confirm({ message: "Continue anyway?", initialValue: false }));
    if (!go) bail("Cancelled. Nothing was changed.");
  }

  const repoUrl = await askRepoUrl(previous);
  const urlError = validateRepoUrl(repoUrl);
  if (urlError) bail(urlError);

  const spin = p.spinner();
  if (!previous || args.repo) {
    spin.start("Checking access to the repo");
    const remoteError = checkRemote(repoUrl);
    if (remoteError) {
      spin.stop("No access");
      bail(`${remoteError}\nIs the URL right, and is this machine's SSH key registered with the git server?`);
    }
    spin.stop("Repo reachable");
  }

  spin.start("Fetching the latest state");
  let synced;
  let repo;
  try {
    synced = syncRepo(repoUrl, { ref: args.ref });
    repo = scanRepo(synced.dir);
  } catch (err) {
    spin.stop("Failed");
    bail(err.message);
  }
  spin.stop(`At ${synced.commit}${previous?.commit && previous.commit !== synced.commit ? ` (was ${previous.commit})` : ""}`);

  const diff = diffItems(previous?.hashes, repo.items);
  if (previous) {
    const lines = [
      diff.added.length ? `new:       ${diff.added.join(", ")}` : null,
      diff.changed.length ? `changed:   ${diff.changed.join(", ")}` : null,
      diff.removed.length ? `removed:   ${diff.removed.join(", ")}` : null,
    ].filter(Boolean);
    p.note(lines.length ? lines.join("\n") : "No changes since the last run.", "Changes in the repo");
  }

  const byType = (type) => repo.items.filter((it) => it.type === type);
  const prevSelection = new Set(previous?.selection ?? []);
  const isPreselected = (it) => (previous ? prevSelection.has(key(it)) : it.default);

  let selectedKeys = new Set();
  for (const type of Object.keys(LABELS)) {
    const items = byType(type).filter((it) => !it.required);
    for (const it of byType(type).filter((x) => x.required)) selectedKeys.add(key(it));
    if (!items.length) continue;
    const preselected = new Set(items.filter(isPreselected).map(key));
    const chosen = unattended ? preselected : await pickItems(type, items, preselected, diff);
    for (const k of chosen) selectedKeys.add(k);
  }

  const sets = byType("permissions");
  const prevAllow = new Set(previous?.allow ?? []);
  const prevDeny = new Set(previous?.deny ?? []);
  let allowIds = new Set(sets.filter((s) => (previous ? prevAllow.has(s.id) : s.mode === "allow")).map((s) => s.id));
  let denyIds = new Set(sets.filter((s) => (previous ? prevDeny.has(s.id) : s.mode === "deny")).map((s) => s.id));

  if (sets.length && !unattended) {
    const option = (s) => ({ value: s.id, label: s.label, hint: hint(s, diff) });
    allowIds = new Set(
      guard(
        await p.multiselect({
          message: "What may Claude do without asking?",
          options: sets.map(option),
          initialValues: [...allowIds],
          required: false,
        }),
      ),
    );
    const rest = sets.filter((s) => !allowIds.has(s.id));
    denyIds = rest.length
      ? new Set(
          guard(
            await p.multiselect({
              message: "What must Claude never do? (everything else: Claude asks each time)",
              options: rest.map(option),
              initialValues: [...denyIds].filter((id) => !allowIds.has(id)),
              required: false,
            }),
          ),
        )
      : new Set();
  }

  const excludes = globalExcludesFile();
  let addScratch = false;
  if (!hasLine(excludes, ".scratch/") && !unattended) {
    addScratch = guard(
      await p.confirm({ message: `Ignore .scratch/ globally? (adds it to ${excludes})`, initialValue: true }),
    );
  }

  const selection = repo.items.filter((it) => selectedKeys.has(key(it)));
  const allow = sets.filter((s) => allowIds.has(s.id));
  const deny = sets.filter((s) => denyIds.has(s.id));
  const counts = countByType(selection);
  const toRemove = managedEntries(target);

  const summary = [
    `Target:      ${target}`,
    `Repo:        ${repoUrl} @ ${synced.commit}`,
    ...Object.entries(LABELS).map(([type, label]) => `${label.padEnd(12).slice(0, 12)} ${counts[type] ?? 0}`),
    `Allowed:     ${allow.map((s) => s.id).join(", ") || "–"}`,
    `Denied:      ${deny.map((s) => s.id).join(", ") || "–"}`,
    `Replaced:    ${toRemove.length} existing entries in skills/, agents/, commands/, hooks/, CLAUDE.md`,
    `Backup:      ${backupDirFor(target)}`,
  ].join("\n");

  if (args["dry-run"]) {
    p.note(summary, "Dry run, nothing will change");
    p.outro("Done (dry run).");
    return;
  }

  if (!unattended) {
    p.note(summary, "Summary");
    const ok = guard(await p.confirm({ message: "Install now?", initialValue: true }));
    if (!ok) bail("Cancelled. Nothing was changed.");
  }

  spin.start("Installing");
  try {
    const result = install({
      repoDir: synced.dir,
      repo,
      target,
      selection,
      allow,
      deny,
      meta: { repoUrl, commit: synced.commit, targetForCommands },
    });
    if (addScratch) ensureLine(excludes, ".scratch/", "Temporary notes, never committed");
    spin.stop("Installed");
    if (result.backup) p.log.info(`Backup: ${result.backup}`);
    if (addScratch) p.log.info(`Added .scratch/ to ${excludes}`);
    p.outro("Restart Claude Code to load everything.");
  } catch (err) {
    spin.stop("Failed");
    bail(`${err.message}\nBackup is in ${backupDirFor(target)}.`);
  }
}

await main();
