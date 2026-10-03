# cc-kit

Set up Claude Code on any machine from a Git repo you own.

Keep your skills, hooks, agents, commands, CLAUDE.md sections and permission rules in
one repository. On each machine, run `npx cc-kit`, pick what this machine should get,
and cc-kit writes it into `~/.claude`. Change something in the repo, run
`npx cc-kit update` everywhere, done.

```sh
npx cc-kit            # first run asks for your repo URL, then lets you pick
npx cc-kit update     # latest repo state, same selection, no questions
```

> The interactive prompts are currently in German.

## Why

- **One source of truth.** Your setup lives in Git, not scattered across machines.
- **Per-machine choice.** The client laptop doesn't get the skills of another client;
  the server may run `kubectl apply`, the laptop may not.
- **No sync daemon, no hooks of its own.** cc-kit runs when you run it and does
  nothing in between.

## Repository layout

Everything is optional; empty categories are skipped.

```
skills/<name>/SKILL.md              plus any other files in that folder
agents/<name>.md
commands/<name>.md
hooks/<name>/hook.yaml              plus the script(s) it runs
claude-md/<NN>-<name>.md            sections of CLAUDE.md, ordered by number
settings/base.yaml                  any other settings.json keys
settings/permissions/<name>.yaml    named permission rule sets
cc-kit.yaml                         optional: name
```

Names starting with `_` or `.` are ignored.

### Hooks

```yaml
# hooks/bash-safety/hook.yaml
description: Blocks irreversible shell commands
default: true            # preselected in the picker
event: PreToolUse
matcher: Bash
if: "Bash(git commit*)"  # optional
command: python3 {{dir}}/bash-safety.py
```

`{{dir}}` becomes the installed folder, e.g. `~/.claude/hooks/bash-safety`. cc-kit
registers the hook in `settings.json` for you.

### CLAUDE.md sections

```markdown
---
title: Workflow
description: Every change needs approval
default: true
---

## Workflow
…
```

Selected sections are concatenated in file-name order, without frontmatter. A section
with `required: true` is always included and not asked for.

### Permissions

```yaml
# settings/permissions/kubectl-write.yaml
description: Change Kubernetes resources
default: ask             # allow | ask | deny
rules:
  - Bash(kubectl apply:*)
  - Bash(kubectl delete:*)
```

cc-kit asks which sets to **allow** and which to **deny**. Anything in neither is left
to Claude Code's default: it asks before each use. Rules use Claude Code's permission
syntax (`Edit`, `Bash(cmd:*)`, `WebFetch(domain:x.com)`, `mcp__server__tool`, …).

### Other settings

`settings/base.yaml` is written into `settings.json` as is — model, attribution,
plugins and so on. It must not contain `hooks` or `permissions`.

## What a run does

1. Fetches your repo into `~/.cache/cc-kit/` with your normal `git` credentials. Any
   URL `git clone` understands works; SSH is recommended for private repos.
2. Shows what changed since the last run: new, changed, removed.
3. Lets you pick (previous choice preselected).
4. Backs up `~/.claude` (managed parts) to `~/.claude.cc-kit-backups/`, keeps the last 10.
5. Replaces `skills/`, `agents/`, `commands/`, `hooks/` and `CLAUDE.md` with your
   selection, and sets the repo's keys in `settings.json`. Other keys — your
   `statusLine`, theme, … — are kept.
6. Optionally adds `.scratch/` to your global git ignore file.

Never touched: `projects/` (including memory), `claude.json`, sessions, history, caches,
plugins, and `skills/synced/` / `skills/.trash/`.

Edit your setup in the repo, not in `~/.claude` — the next run overwrites local changes.

## Options

```
--repo <url>     set or change the repo URL
--ref <branch>   use another branch or tag
--target <dir>   install somewhere else than ~/.claude
--dry-run        show what would happen
```

Requires Node.js 18+ and git.

## License

MIT
