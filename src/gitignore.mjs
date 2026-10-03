import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolves the global excludes file the same way git does.
export function globalExcludesFile() {
  try {
    const configured = execFileSync("git", ["config", "--global", "--get", "core.excludesFile"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (configured) return configured.replace(/^~(?=$|\/)/, os.homedir());
  } catch {
    // not configured
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "git", "ignore");
}

export function hasLine(file, line) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).some((l) => l.trim() === line);
}

// Appends the line once; leaves the rest of the file untouched.
export function ensureLine(file, line, comment) {
  if (hasLine(file, line)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  const block = `${current ? "\n" : ""}${comment ? `# ${comment}\n` : ""}${line}\n`;
  fs.appendFileSync(file, sep + block);
  return true;
}
