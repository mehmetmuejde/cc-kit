import fs from "node:fs";
import path from "node:path";
import { key } from "./scan.mjs";

const STATE_DIR = ".cc-kit";

export function statePath(target) {
  return path.join(target, STATE_DIR, "state.json");
}

export function loadState(target) {
  try {
    return JSON.parse(fs.readFileSync(statePath(target), "utf8"));
  } catch {
    return null;
  }
}

export function saveState(target, state) {
  fs.mkdirSync(path.join(target, STATE_DIR), { recursive: true });
  fs.writeFileSync(statePath(target), `${JSON.stringify(state, null, 2)}\n`);
}

// Compares the repo now with what the last run saw.
export function diffItems(previousHashes = {}, items) {
  const current = new Map(items.map((it) => [key(it), it.hash]));
  const added = [];
  const changed = [];
  for (const [k, hash] of current) {
    if (!(k in previousHashes)) added.push(k);
    else if (previousHashes[k] !== hash) changed.push(k);
  }
  const removed = Object.keys(previousHashes).filter((k) => !current.has(k));
  return { added, changed, removed };
}
