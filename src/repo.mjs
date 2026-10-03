import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Credentials embedded in an HTTPS URL would end up in the state file.
export function validateRepoUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) return "Bitte eine Repo-URL angeben.";
  if (/^https?:\/\/[^/@]+:[^/@]+@/i.test(value)) {
    return "Bitte keine Zugangsdaten in der URL. SSH verwenden oder den Git-Credential-Helper.";
  }
  return null;
}

export function cacheDir(url, base = path.join(os.homedir(), ".cache", "cc-kit")) {
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
  return path.join(base, hash);
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function gitError(err) {
  const detail = String(err.stderr ?? err.message).trim().split("\n").slice(-3).join("\n");
  return new Error(`git: ${detail}`);
}

// Checks that the URL is reachable with the machine's git credentials.
export function checkRemote(url) {
  try {
    git(["ls-remote", "--heads", url], { timeout: 30_000 });
    return null;
  } catch (err) {
    return gitError(err).message;
  }
}

// Clones or updates the repo in the cache and returns its local path and commit.
export function syncRepo(url, { ref, cacheBase } = {}) {
  const dir = cacheDir(url, cacheBase);
  try {
    if (fs.existsSync(path.join(dir, ".git"))) {
      git(["-C", dir, "remote", "set-url", "origin", url]);
      git(["-C", dir, "fetch", "--prune", "origin"]);
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      git(["clone", "--quiet", url, dir]);
    }
    const target = ref ? `origin/${ref}` : git(["-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
    git(["-C", dir, "checkout", "--quiet", "--detach", target]);
    git(["-C", dir, "clean", "-fdq"]);
    return { dir, commit: git(["-C", dir, "rev-parse", "--short", "HEAD"]) };
  } catch (err) {
    throw gitError(err);
  }
}
