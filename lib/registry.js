/**
 * The shared registries, from the consumer side: talking to skills.okayiris.com and mcp.okayiris.com, and
 * doing the file work an install needs.
 *
 * Two rules shape this file, both of them about safety on somebody else's machine:
 *
 * 1. Nothing is written outside the two places this owns: `~/.dsh/skills/` for a skill and
 *    `~/.dsh/registry/mcp/` for a server's files. The one shared file it touches is the dsh profile patch,
 *    and only between its own markers (`# >>> okayiris-registry` / `# <<< okayiris-registry`), so removing
 *    it can never take somebody else's plugin entry with it.
 * 2. Nothing is taken on faith. Every package is checked against the SHA-256 the registry published before
 *    any byte of it lands on disk, and a server is never registered with more permissions than the owner
 *    has agreed to.
 *
 * @module registry-client
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── what the registries are ──────────────────────────────────────────────────────────────────────
export const SKILLS_URL = 'https://skills.okayiris.com';
export const MCP_URL = 'https://mcp.okayiris.com';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const VERSION_RE = /^\d+\.\d+\.\d+$/u;
const TIMEOUT_MS = 30_000;

/** A failure the model can read and act on, instead of a stack trace. */
export function registryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Fetch one registry URL as text, with a deadline. Never follows a redirect off the two hosts we know. */
async function getText(base, path, signal) {
  const url = `${base}${path}`;
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(new Error('timeout')), TIMEOUT_MS);
  const onAbort = () => timer.abort(signal?.reason);
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { redirect: 'error', headers: { accept: '*/*', 'user-agent': 'okayiris-registry/0.1.0' }, signal: timer.signal });
    if (!response.ok) throw registryError(`${url} answered ${response.status}`, 'REGISTRY_STATUS');
    return await response.text();
  } catch (error) {
    if (error?.code === 'REGISTRY_STATUS') throw error;
    throw registryError(`${url} cannot be reached (${String(error)})`, 'REGISTRY_TRANSPORT');
  } finally {
    clearTimeout(stop);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** One hash over a package, independent of the order of its files: name, a separator byte, the base64, a
 *  separator. Exactly what the registries compute (src/registry.ts), so an install can prove what it got. */
export function packageHash(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(name).update('\0').update(files[name]).update('\0');
  return hash.digest('hex');
}

/** Every entry of one registry, newest first. */
export async function catalog(base, signal) {
  const text = await getText(base, '/api/' + (base === SKILLS_URL ? 'skills' : 'mcp'), signal);
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries;
}

/** Find entries by word and, optionally, tag. Matches name, description, tags and author, all lowercase. */
export function search(entries, query, tag) {
  const words = String(query ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    if (tag !== undefined && entry.tags?.includes(tag) !== true) return false;
    if (!words.length) return true;
    const haystack = [entry.name, entry.description, entry.author, ...(entry.tags ?? [])].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The text of one skill, as the model reads it: the registry's own Markdown twin. */
export const skillText = (name, signal) => getText(SKILLS_URL, `/s/${encodeURIComponent(name)}.md`, signal);

/** One package: `{ meta, files, hash, published }`. The hash is checked by the caller before anything is
 *  written; a package whose bytes do not match is refused, not repaired. */
export async function fetchPackage(base, name, version, signal) {
  if (!NAME_RE.test(name)) throw registryError(`"${name}" is not a valid name`, 'REGISTRY_ARGS');
  if (version !== undefined && !VERSION_RE.test(version)) throw registryError(`"${version}" is not a version`, 'REGISTRY_ARGS');
  const text = await getText(base, `/api/${base === SKILLS_URL ? 'skills' : 'mcp'}/${encodeURIComponent(name)}${version ? `/${version}` : ''}`, signal);
  const pkg = JSON.parse(text);
  if (!pkg?.files || typeof pkg.files !== 'object') throw registryError(`${name}: the registry returned no package`, 'REGISTRY_SHAPE');
  const computed = packageHash(pkg.files);
  if (computed !== pkg.hash) {
    throw registryError(`${name}: the package does not match its published hash (${computed.slice(0, 12)} vs ${String(pkg.hash).slice(0, 12)}); nothing was installed`, 'REGISTRY_HASH');
  }
  return pkg;
}

// ─── what a house keeps on disk ───────────────────────────────────────────────────────────────────
export const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const skillsDir = () => join(homeDir(), 'skills');
export const mcpDir = () => join(homeDir(), 'registry', 'mcp');
/** What this house installed from a registry, and what its owner agreed to. One file, no secrets in it. */
export const statePath = () => join(homeDir(), 'registry', 'installed.json');

export async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    return { skills: parsed?.skills ?? {}, mcp: parsed?.mcp ?? {} };
  } catch {
    return { skills: {}, mcp: {} };
  }
}

async function writeState(state) {
  await mkdir(join(homeDir(), 'registry'), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2) + '\n');
}

const writeFiles = async (dir, files, decode) => {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    if (!/^[\w][\w.-]{0,63}$/u.test(name)) throw registryError(`refusing to write "${name}" (flat file names only)`, 'REGISTRY_PATH');
    await writeFile(join(dir, name), decode(body));
  }
};

/** The frontmatter dsh reads, kept as it came: what is written is what was published. */
export const installSkill = async (pkg, signal) => {
  const name = pkg.meta.name;
  const dir = join(skillsDir(), name);
  await writeFiles(dir, pkg.files, (b64) => Buffer.from(b64, 'base64').toString('utf8'));
  const state = await readState();
  state.skills[name] = { version: pkg.meta.version, hash: pkg.hash, at: new Date().toISOString(), author: pkg.meta.author,
    license: pkg.meta.license, sources: pkg.meta.sources ?? [] };
  await writeState(state);
  return { name, version: pkg.meta.version, dir, files: Object.keys(pkg.files).length };
};

export const forgetSkill = async (name) => {
  const state = await readState();
  if (state.skills[name]) { delete state.skills[name]; await writeState(state); }
  await rm(join(skillsDir(), name), { recursive: true, force: true });
};

// ─── mcp: the files, and the one line the harness needs ───────────────────────────────────────────
const MARK_START = '# >>> okayiris-registry';
const MARK_END = '# <<< okayiris-registry';

/** Which patch file the loader entries go into.
 *
 *  The default is `~/.dsh/mcp.yml`, the file a house's own start adds with `--patch`
 *  (`mcp install` in a sandbox writes the same one). A profile name instead of a path
 *  (`patchFile: web`) means that profile's own patch file, for a machine set up that way. */
export function patchPath(patchFile) {
  if (patchFile === undefined || patchFile === '') return join(homeDir(), 'mcp.yml');
  return patchFile.includes('/') ? patchFile : join(homeDir(), 'profiles', patchFile, 'cordis.patch.yml');
}

/** The loader entry for one server: exactly what `@deepseek-ai/dsh-mcp-client` documents, one instance per
 *  server, with its own id and serverName so two never collide. */
export function patchEntry(name, meta, dir) {
  const lines = [`    - id: mcp-${name}`, `      name: '@deepseek-ai/dsh-mcp-client'`, '      config:', `        serverName: ${name}`];
  if (meta.transport === 'stdio') {
    lines.push('        transport: stdio');
    lines.push(`        command: ${JSON.stringify(join(dir, meta.command))}`);
    if (meta.args?.length) lines.push(`        args: ${JSON.stringify(meta.args)}`);
    const env = Object.entries(meta.env ?? {});
    if (env.length) {
      lines.push('        env:');
      for (const [key, reference] of env) {
        // A reference, never a value: `$NAME` reads the house's own environment, `vault:name` is filled by
        // the vault at start. A literal secret in this file would be a secret in a config file.
        lines.push(`          ${key}: ${reference.startsWith('$') ? `!!js process.env.${reference.slice(1)}` : JSON.stringify(reference)}`);
      }
    }
    if (meta.toolCallTimeoutMs) lines.push(`        toolCallTimeoutMs: ${meta.toolCallTimeoutMs}`);
  } else {
    lines.push('        transport: streamable-http');
    lines.push(`        url: ${JSON.stringify(meta.url)}`);
    if (meta.toolCallTimeoutMs) lines.push(`        toolCallTimeoutMs: ${meta.toolCallTimeoutMs}`);
  }
  return lines.join('\n') + '\n';
}

/** Rewrites only our own marked block in the profile patch. Everything above and below it is left exactly
 *  as it was: this file belongs to whoever runs the profile, not to this plugin. */
export function mergePatch(text, entries) {
  const body = entries.length ? `- insert:\n${entries.join('')}` : '';
  const block = `${MARK_START}\n${body}${MARK_END}\n`;
  const start = text.indexOf(MARK_START);
  if (start < 0) {
    const separator = text.length && !text.endsWith('\n') ? '\n' : '';
    return text + separator + (text.trim().length ? '\n' : '') + block;
  }
  const end = text.indexOf(MARK_END, start);
  if (end < 0) throw registryError(`the profile patch has a start marker for this plugin but no end marker; fix that by hand first`, 'REGISTRY_PATCH');
  return text.slice(0, start) + block + text.slice(end + MARK_END.length + 1);
}

/** What is in our block right now, as server names, so the plugin can rewrite the whole set at once. */
export function patchNames(text) {
  const start = text.indexOf(MARK_START);
  if (start < 0) return [];
  const end = text.indexOf(MARK_END, start);
  if (end < 0) return [];
  return [...text.slice(start, end).matchAll(/^ {4}- id: mcp-([a-z0-9-]+)$/gmu)].map((m) => m[1]);
}

export const installMcp = async (pkg, { patchFile, acknowledged }) => {
  const name = pkg.meta.name;
  const extra = (pkg.meta.permissions ?? []).filter((p) => !(acknowledged ?? []).includes(p));
  if (extra.length) {
    throw registryError(`${name} asks for ${extra.join(', ')}; say yes to that first (acknowledge: [${extra.join(', ')}])`, 'REGISTRY_PERMISSIONS');
  }
  const dir = join(mcpDir(), name);
  await writeFiles(dir, pkg.files, (b64) => Buffer.from(b64, 'base64'));
  // A stdio server needs to be runnable: the file it names as its command, executable by its shebang or by
  // its ending. Only the file the manifest names, never anything else in the package.
  if (pkg.meta.transport === 'stdio') {
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, pkg.meta.command), 0o755).catch(() => {});
  }
  const path = patchPath(patchFile);
  const before = existsSync(path) ? await readFile(path, 'utf8') : '';
  const kept = patchNames(before);
  const entries = [];
  const state = await readState();
  state.mcp[name] = { version: pkg.meta.version, hash: pkg.hash, transport: pkg.meta.transport,
    permissions: pkg.meta.permissions ?? [], dir, at: new Date().toISOString(), author: pkg.meta.author };
  await writeState(state);
  for (const other of [...new Set([...kept, name])].sort()) {
    const known = other === name ? state.mcp[name] : state.mcp[other];
    if (!known) continue;                                     // a name in the patch we have no state for: leave it out
    const meta = other === name ? pkg.meta : (await readFile(join(mcpDir(), other, 'mcp.json'), 'utf8').then(JSON.parse, () => null));
    if (!meta) continue;
    entries.push(patchEntry(other, meta, join(mcpDir(), other)));
  }
  await writeFile(path, mergePatch(before, entries.length ? [entries.join('')] : []));
  return { name, version: pkg.meta.version, dir, patch: path, toolPrefix: `mcp__${name}__` };
};

export const forgetMcp = async (name, patchFile) => {
  const state = await readState();
  delete state.mcp[name];
  await writeState(state);
  const path = patchPath(patchFile);
  const before = existsSync(path) ? await readFile(path, 'utf8') : '';
  const entries = [];
  for (const other of [...new Set(patchNames(before))].filter((n) => n !== name).sort()) {
    const meta = await readFile(join(mcpDir(), other, 'mcp.json'), 'utf8').then(JSON.parse, () => null);
    if (meta) entries.push(patchEntry(other, meta, join(mcpDir(), other)));
  }
  await writeFile(path, mergePatch(before, entries.length ? [entries.join('')] : []));
  await rm(join(mcpDir(), name), { recursive: true, force: true });
  return { name, removed: true };
};

// ─── contributing back ────────────────────────────────────────────────────────────────────────────
// The secret scan, the same shapes the registry refuses (src/registry.ts). A contribution from here should
// fail here, with a sentence, rather than after a round trip or, worse, never.
const SECRETS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an OpenAI-style key', /\b(?:sk|rk)-[A-Za-z0-9_-]{24,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['a Stripe key', /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['a written-out secret', /(?:api[_-]?key|apikey|secret|password|passwd|token|client[_-]?secret)["']?\s*[:=]\s*["'](?![$<{]|vault:|secret:|env:|\.\.\.)[^"'\s]{12,}["']/i],
];

/** Every secret-looking thing in a package. One line per hit, empty when clean. */
export function secretHits(files) {
  const hits = [];
  for (const [name, body] of Object.entries(files)) {
    let text;
    try { text = Buffer.from(body, 'base64').toString('utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const [what, re] of SECRETS) if (re.test(text)) hits.push(`${name}: looks like it carries ${what}`);
  }
  return [...new Set(hits)];
}

/** Checks a local folder the way the registry does, so a submission is refused here rather than after a
 *  round trip. Returns the files (base64), the meta, and everything that is wrong with it. */
export async function readFolder(dir, kind) {
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.') && n !== '__pycache__');
  const errors = [];
  for (const n of names) {
    if (!/^[\w][\w.-]{0,63}$/u.test(n)) { errors.push(`${n}: flat file names only`); }
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '';
    const allowed = kind === 'mcp' ? ['py', 'js', 'mjs', 'cjs', 'ts', 'json', 'md', 'txt', 'yml', 'yaml'] : ['md', 'txt', 'json', 'yml', 'yaml'];
    if (!allowed.includes(ext)) { errors.push(`${n}: .${ext} is not allowed in a ${kind === 'mcp' ? 'server' : 'skill'}`); }
  }
  if (kind === 'skill' && !names.includes('SKILL.md')) errors.push('SKILL.md is missing');
  const manifestName = kind === 'mcp' ? 'mcp.json' : 'skill.json';
  if (!names.includes(manifestName)) errors.push(`${manifestName} is missing`);
  const files = {};
  for (const n of names) {
    const body = await readFile(join(dir, n));
    if (body.length > 6_000_000) { errors.push(`${n}: bigger than 6 MB`); continue; }
    if (body.includes(0)) { errors.push(`${n}: binary files are not allowed`); continue; }
    files[n] = body.toString('base64');
  }
  let meta = null;
  if (files[manifestName]) {
    try { meta = JSON.parse(Buffer.from(files[manifestName], 'base64').toString('utf8')); }
    catch { errors.push(`${manifestName} is not valid JSON`); }
  }
  if (meta && meta.name !== dir.replace(/\/+$/u, '').split('/').pop()) errors.push(`name "${meta.name}" must equal the folder name`);
  if (kind === 'skill' && files['SKILL.md'] && meta) {
    const md = Buffer.from(files['SKILL.md'], 'base64').toString('utf8');
    for (const key of ['name', 'description', 'whenToUse']) {
      if (!new RegExp(`^${key}:\\s*\\S`, 'mu').test(md)) errors.push(`SKILL.md frontmatter: ${key} is missing`);
    }
    const front = /^name:\s*(.+)$/mu.exec(md);
    if (front && meta && front[1].trim() !== meta.name) errors.push(`SKILL.md frontmatter name "${front[1].trim()}" must equal skill.json name "${meta.name}"`);
    if (!(meta.sources ?? []).length) errors.push('skill.json sources: name at least one https link the research read');
    if (!meta.license) errors.push('skill.json license is missing');
  }
  return { files, meta, names, errors };
}

/** The title and body of a commit message / pull request: what a reviewer reads first. */
export function submissionText(kind, meta) {
  return [
    `Add ${kind} ${meta.name} ${meta.version}`,
    '',
    `What it is: ${meta.description}`,
    `Author: ${meta.author}`,
    `License: ${meta.license}`,
    '',
    'Sources:',
    ...(meta.sources ?? []).map((s) => `- ${s}`),
    '',
    'Submitted from a house through the shared registry. A person reviews the sources and the honesty of the',
    'permission list before it is published.',
  ].join('\n');
}

/** Submit a package to a registry that trusts this house, over a signed request. The bridge of a hosted
 *  house does this with the house key it already has; a plain machine has none, and falls back to a pull
 *  request (see `REGISTRY_SIGN`/`GITHUB_TOKEN` handling in the tool). */
export async function submit(base, kind, files, { house, key, signal } = {}) {
  if (!house || !key) throw registryError('no house signature on this machine: publish by opening a pull request instead', 'REGISTRY_NO_SIGN');
  const path = `/api/${kind === 'mcp' ? 'mcp' : 'skills'}/publish`;
  const sign = createHmac('sha256', key).update(`market:${house}`).digest('hex');
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const response = await fetch(base + path, { method: 'POST', redirect: 'error', signal: timer.signal,
      headers: { 'content-type': 'application/json', 'x-iris-house': house, 'x-iris-sign': sign },
      body: JSON.stringify({ files }) });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!response.ok) throw registryError(`${payload?.error ?? `the registry answered ${response.status}`}${payload?.errors?.length ? `: ${payload.errors.join('; ')}` : ''}`, 'REGISTRY_REFUSED');
    return payload;
  } finally {
    clearTimeout(stop);
  }
}

/** Open a pull request against the public repository, so a house without a signing key can still contribute.
 *  Every path is checked here as well as by git: only skills/<name>/ and mcp/<name>/, never anything else. */
export async function openPullRequest(files, kind, meta, { token, repo = 'okayiris/registry', branch = 'main', signal } = {}) {
  if (!token) throw registryError('no GITHUB_TOKEN: nothing was pushed. Send the files to whoever runs the registry, or set a token with rights on ' + repo, 'REGISTRY_NO_TOKEN');
  const dir = kind === 'mcp' ? 'mcp' : 'skills';
  const paths = Object.fromEntries(Object.entries(files).map(([name, body]) => [`${dir}/${meta.name}/${name}`, Buffer.from(body, 'base64').toString('utf8')]));
  for (const path of Object.keys(paths)) {
    if (!/^(?:skills|mcp)\/[a-z0-9][a-z0-9-]{0,39}\/[\w][\w.-]{0,63}$/u.test(path)) throw registryError(`refusing to push "${path}"`, 'REGISTRY_PATH');
  }
  const api = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'okayiris-registry', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
    return { status: response.status, data };
  };
  const head = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`);
  if (head.status !== 200) throw registryError(`cannot read ${repo}@${branch} (${head.status}: ${head.data?.message ?? ''})`, 'REGISTRY_REPO');
  const base = await api('GET', `/repos/${repo}/git/commits/${head.data.object.sha}`);
  const tree = [];
  for (const [path, text] of Object.entries(paths)) {
    const blob = await api('POST', `/repos/${repo}/git/blobs`, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });
    if (blob.status !== 201) throw registryError(`blob for ${path} failed (${blob.status})`, 'REGISTRY_REPO');
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }
  const madeTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: base.data.tree.sha, tree });
  if (madeTree.status !== 201) throw registryError(`tree failed (${madeTree.status})`, 'REGISTRY_REPO');
  const madeCommit = await api('POST', `/repos/${repo}/git/commits`, { message: submissionText(kind, meta), tree: madeTree.data.sha, parents: [head.data.object.sha] });
  if (madeCommit.status !== 201) throw registryError(`commit failed (${madeCommit.status})`, 'REGISTRY_REPO');
  const topic = `registry/${kind}-${meta.name}-${meta.version}`;
  const madeRef = await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${topic}`, sha: madeCommit.data.sha });
  if (madeRef.status !== 201) throw registryError(`the branch ${topic} could not be made (${madeRef.status})`, 'REGISTRY_REPO');
  const pr = await api('POST', `/repos/${repo}/pulls`, { title: `Add ${kind} ${meta.name} ${meta.version}`,
    head: topic, base: branch, body: submissionText(kind, meta) });
  if (pr.status !== 201) throw registryError(`the pull request could not be opened (${pr.status}: ${pr.data?.message ?? ''})`, 'REGISTRY_REPO');
  return { branch: topic, url: pr.data.html_url, number: pr.data.number, files: Object.keys(paths) };
}

/** Removing a skill from a house, and the server from its own profile: the two ways back out. */
export const knownSkills = async () => Object.keys((await readState()).skills);
export const knownMcp = async () => Object.keys((await readState()).mcp);
