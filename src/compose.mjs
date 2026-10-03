// Builds CLAUDE.md and settings.json from the selected items.

export function buildClaudeMd(sections) {
  const parts = sections.map((s) => s.body).filter(Boolean);
  if (!parts.length) return null;
  return `${parts.join("\n\n")}\n`;
}

function hookEntry(hook, dir) {
  const entry = { type: "command", command: hook.command.replaceAll("{{dir}}", dir) };
  if (hook.if) entry.if = hook.if;
  if (hook.timeout) entry.timeout = hook.timeout;
  return entry;
}

// Groups hooks by event and matcher in the shape settings.json expects.
export function buildHooks(hooks, targetDir) {
  const result = {};
  for (const item of hooks) {
    const { event, matcher } = item.hook;
    const dir = `${targetDir}/hooks/${item.id}`;
    const groups = (result[event] ??= []);
    let group = groups.find((g) => g.matcher === matcher);
    if (!group) {
      group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
      groups.push(group);
    }
    group.hooks.push(hookEntry(item.hook, dir));
  }
  return result;
}

const unique = (list) => [...new Set(list)];

// Only the keys the repo manages are replaced; everything else in the existing
// settings (statusLine from ccstatusline, theme, …) stays as it is.
export function buildSettings({ existing = {}, base = {}, hooks = [], allow = [], deny = [], targetDir }) {
  const settings = { ...existing, ...structuredClone(base) };

  const permissions = { ...(existing.permissions ?? {}) };
  permissions.allow = unique(allow.flatMap((set) => set.rules));
  permissions.deny = unique(deny.flatMap((set) => set.rules));
  if (!permissions.allow.length) delete permissions.allow;
  if (!permissions.deny.length) delete permissions.deny;
  if (Object.keys(permissions).length) settings.permissions = permissions;
  else delete settings.permissions;

  const builtHooks = buildHooks(hooks, targetDir);
  if (Object.keys(builtHooks).length) settings.hooks = builtHooks;
  else delete settings.hooks;

  return settings;
}
