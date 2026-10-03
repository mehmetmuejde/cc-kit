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

const HELP = `cc-kit — Claude Code aus einem Git-Repo einrichten

  npx cc-kit                 interaktiv; fragt beim ersten Mal nach der Repo-URL
  npx cc-kit update          neuer Repo-Stand, gleiche Auswahl, keine Rückfragen

Optionen
  --repo <url>     Repo-URL setzen oder wechseln (SSH oder HTTPS)
  --ref <branch>   anderen Branch oder Tag verwenden
  --target <dir>   Zielordner (Standard: ~/.claude)
  --dry-run        nur anzeigen, nichts schreiben
  -h, --help       diese Hilfe
`;

const LABELS = {
  skills: "Skills",
  hooks: "Hooks",
  agents: "Agents",
  commands: "Commands",
  claudeMd: "CLAUDE.md-Abschnitte",
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
  process.stderr.write(`Unbekannter Befehl: ${command}\n\n${HELP}`);
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
  if (p.isCancel(value)) bail("Abgebrochen. Es wurde nichts verändert.");
  return value;
}

function hint(item, diff) {
  const flag = diff.added.includes(key(item)) ? "neu · " : diff.changed.includes(key(item)) ? "geändert · " : "";
  const text = `${flag}${item.description}`;
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

async function askRepoUrl(previous) {
  if (args.repo) return args.repo;
  if (previous?.repoUrl) return previous.repoUrl;
  if (unattended) bail("Noch kein Repo eingerichtet. Erst `npx cc-kit` interaktiv ausführen.");
  return guard(
    await p.text({
      message: "URL deines Konfigurations-Repos (SSH oder HTTPS)",
      placeholder: "ssh://git@git.example.com/du/claude-config.git",
      validate: validateRepoUrl,
    }),
  );
}

async function pickItems(type, items, preselected, diff) {
  const options = items.map((it) => ({ value: key(it), label: it.label, hint: hint(it, diff) }));
  const chosen = guard(
    await p.multiselect({
      message: `${LABELS[type]} (Leertaste wählt, Enter bestätigt)`,
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
    p.log.warn(`${target} ist ein Git-Repo. cc-kit überschreibt dort verwaltete Dateien.`);
    if (unattended) bail("Abgebrochen: Zielordner ist ein Git-Repo.");
    const go = guard(await p.confirm({ message: "Trotzdem fortfahren?", initialValue: false }));
    if (!go) bail("Abgebrochen. Es wurde nichts verändert.");
  }

  const repoUrl = await askRepoUrl(previous);
  const urlError = validateRepoUrl(repoUrl);
  if (urlError) bail(urlError);

  const spin = p.spinner();
  if (!previous || args.repo) {
    spin.start("Prüfe Zugriff auf das Repo");
    const remoteError = checkRemote(repoUrl);
    if (remoteError) {
      spin.stop("Kein Zugriff");
      bail(`${remoteError}\nStimmt die URL, und ist der SSH-Key dieses Geräts beim Git-Server hinterlegt?`);
    }
    spin.stop("Repo erreichbar");
  }

  spin.start("Hole den aktuellen Stand");
  let synced;
  let repo;
  try {
    synced = syncRepo(repoUrl, { ref: args.ref });
    repo = scanRepo(synced.dir);
  } catch (err) {
    spin.stop("Fehlgeschlagen");
    bail(err.message);
  }
  spin.stop(`Stand ${synced.commit}${previous?.commit && previous.commit !== synced.commit ? ` (vorher ${previous.commit})` : ""}`);

  const diff = diffItems(previous?.hashes, repo.items);
  if (previous) {
    const lines = [
      diff.added.length ? `neu:       ${diff.added.join(", ")}` : null,
      diff.changed.length ? `geändert:  ${diff.changed.join(", ")}` : null,
      diff.removed.length ? `entfernt:  ${diff.removed.join(", ")}` : null,
    ].filter(Boolean);
    p.note(lines.length ? lines.join("\n") : "Keine Änderungen seit dem letzten Lauf.", "Änderungen im Repo");
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
          message: "Was soll Claude ohne Nachfrage dürfen?",
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
              message: "Was soll Claude nie dürfen? (Rest: Claude fragt jedes Mal)",
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
      await p.confirm({ message: `.scratch/ global ignorieren? (trägt es in ${excludes} ein)`, initialValue: true }),
    );
  }

  const selection = repo.items.filter((it) => selectedKeys.has(key(it)));
  const allow = sets.filter((s) => allowIds.has(s.id));
  const deny = sets.filter((s) => denyIds.has(s.id));
  const counts = countByType(selection);
  const toRemove = managedEntries(target);

  const summary = [
    `Ziel:        ${target}`,
    `Repo:        ${repoUrl} @ ${synced.commit}`,
    ...Object.entries(LABELS).map(([type, label]) => `${label.padEnd(12).slice(0, 12)} ${counts[type] ?? 0}`),
    `Erlaubt:     ${allow.map((s) => s.id).join(", ") || "–"}`,
    `Verboten:    ${deny.map((s) => s.id).join(", ") || "–"}`,
    `Ersetzt:     ${toRemove.length} vorhandene Einträge in skills/, agents/, commands/, hooks/, CLAUDE.md`,
    `Backup:      ${backupDirFor(target)}`,
  ].join("\n");

  if (args["dry-run"]) {
    p.note(summary, "Testlauf, nichts wird verändert");
    p.outro("Fertig (Testlauf).");
    return;
  }

  if (!unattended) {
    p.note(summary, "Zusammenfassung");
    const ok = guard(await p.confirm({ message: "Jetzt installieren?", initialValue: true }));
    if (!ok) bail("Abgebrochen. Es wurde nichts verändert.");
  }

  spin.start("Installiere");
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
    spin.stop("Installiert");
    if (result.backup) p.log.info(`Backup: ${result.backup}`);
    if (addScratch) p.log.info(`.scratch/ in ${excludes} eingetragen`);
    p.outro("Claude Code neu starten, damit alles geladen wird.");
  } catch (err) {
    spin.stop("Fehlgeschlagen");
    bail(`${err.message}\nDas Backup liegt unter ${backupDirFor(target)}.`);
  }
}

await main();
