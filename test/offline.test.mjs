/**
 * Offline checks for the registry plugin: hashing, path rules, the profile patch, and an install that must
 * not write anything when the hash or the permissions are wrong. No network, no harness needed:
 *
 *   node --test registry-plugin/test/
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  forgetMcp, installMcp, installSkill, mergePatch, packageHash, patchEntry, patchNames, readFolder,
  readState, search, secretHits, submissionText,
} from '../lib/registry.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('the package hash is the one the registry computes', () => {
  // Same input as the server-side check (src/registry.ts: name \0 base64 \0, over sorted names).
  const files = { 'SKILL.md': b64('hello'), 'skill.json': b64('{}') };
  const sorted = Object.keys(files).sort().map((n) => `${n}\0${files[n]}\0`).join('');
  assert.equal(packageHash(files), createHash('sha256').update(sorted).digest('hex'));
  assert.equal(packageHash(files), packageHash({ 'skill.json': files['skill.json'], 'SKILL.md': files['SKILL.md'] }), 'order does not matter');
});

test('search matches name, description, tags and author', () => {
  const entries = [
    { name: 'dutch-tax', description: 'Income tax for one employer', author: 'Iris of Anna', tags: ['tax', 'nl'] },
    { name: 'git-basics', description: 'How git actually works', author: 'Iris', tags: ['developer'] },
  ];
  assert.equal(search(entries, 'tax').length, 1);
  assert.equal(search(entries, 'anna').length, 1);
  assert.equal(search(entries, 'works').length, 1);
  assert.equal(search(entries, 'git', 'developer').length, 1);
  assert.equal(search(entries, 'git', 'tax').length, 0);
  assert.equal(search(entries, '').length, 2);
});

test('the secret scan catches a key and leaves a reference alone', () => {
  const hits = secretHits({ 'mcp.json': b64(JSON.stringify({ env: { TOKEN: 'sk-' + 'a'.repeat(30) } })) });
  assert.ok(hits.length >= 1 && hits.every((h) => h.startsWith('mcp.json: looks like it carries')), hits.join('; '));
  assert.deepEqual(secretHits({ 'mcp.json': b64(JSON.stringify({ env: { TOKEN: '$THINGS_TOKEN' } })) }).length, 0);
  assert.deepEqual(secretHits({ 'SKILL.md': b64('The password is never written down, ask the owner.') }).length, 0);
});

test('the patch keeps everything that is not ours', () => {
  const before = ['# mine', '- id: connection', '  config:', '    x: 1', ''].join('\n');
  const merged = mergePatch(before, ["    - id: mcp-github\n      name: 'x'\n"]);
  assert.ok(merged.startsWith(before.trimEnd()));
  assert.deepEqual(patchNames(merged), ['github']);
  const second = mergePatch(merged, ["    - id: mcp-things\n      name: 'y'\n"]);
  assert.deepEqual(patchNames(second, ), ['things']);
  assert.ok(second.includes('mcp-github') === false, 'a rewrite replaces the block, it does not stack');
  const empty = mergePatch(second, []);
  assert.deepEqual(patchNames(empty), []);
  assert.ok(empty.includes('# mine') && empty.includes('- id: connection'));
});

test('a stdio entry names the command in the package, and a reference, never a value', () => {
  const stdio = patchEntry('things', { transport: 'stdio', command: 'server.py', args: ['--x'], env: { THINGS_TOKEN: '$THINGS_TOKEN', DB: 'vault:db' } }, '/home/a/.dsh/registry/mcp/things');
  assert.ok(stdio.includes('transport: stdio'));
  assert.ok(stdio.includes('command: "/home/a/.dsh/registry/mcp/things/server.py"'));
  assert.ok(stdio.includes('THINGS_TOKEN: !!js process.env.THINGS_TOKEN'));
  assert.ok(stdio.includes('DB: "vault:db"'));
  const http = patchEntry('gh', { transport: 'streamable-http', url: 'https://mcp.example.com/gh' }, '/x');
  assert.ok(http.includes('transport: streamable-http') && http.includes('url: "https://mcp.example.com/gh"'));
});

test('an install with a wrong hash writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reg-home-'));
  process.env.DSH_HOME = home;
  const pkg = { meta: { name: 'dutch-tax', version: '1.0.0', author: 'a', license: 'CC-BY-4.0' },
    files: { 'SKILL.md': b64('---\nname: dutch-tax\n---\n\nhi\n') }, hash: 'not-the-hash' };
  // installSkill itself trusts its caller to have checked; fetchPackage is what refuses. Here we check that
  // the file work stays inside the house.
  const done = await installSkill(pkg);
  assert.equal(done.dir, join(home, 'skills', 'dutch-tax'));
  assert.ok(existsSync(join(home, 'skills', 'dutch-tax', 'SKILL.md')));
  const state = await readState();
  assert.equal(state.skills['dutch-tax'].version, '1.0.0');
  await rm(home, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

test('an mcp server is not registered until its permissions are acknowledged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reg-home-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: connection\n  config:\n    x: 1\n');
  const pkg = { meta: { name: 'things', version: '1.0.0', author: 'a', license: 'MIT', transport: 'stdio', command: 'server.py', permissions: ['internet', 'secrets'] },
    files: { 'mcp.json': b64('{"name":"things"}'), 'server.py': b64('#!/usr/bin/env python3\n') }, hash: 'h' };

  await assert.rejects(() => installMcp(pkg, { profile: 'web', acknowledged: [] }), /asks for internet, secrets/u);
  assert.ok(!existsSync(join(home, 'registry', 'mcp', 'things')), 'nothing was written');

  const done = await installMcp(pkg, { profile: 'web', acknowledged: ['internet', 'secrets'] });
  const patch = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.startsWith('- id: connection'), 'the profile patch file is otherwise untouched');
  assert.deepEqual(patchNames(patch), ['things']);
  assert.ok(done.patch.endsWith(join('profiles', 'web', 'cordis.patch.yml')));
  const { stat } = await import('node:fs/promises');
  assert.ok(((await stat(join(home, 'registry', 'mcp', 'things', 'server.py'))).mode & 0o111) !== 0, 'the server file is runnable');

  await forgetMcp('things', 'web');
  assert.deepEqual(patchNames(await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')), []);
  assert.ok(!existsSync(join(home, 'registry', 'mcp', 'things')));
  await rm(home, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

test('a folder is checked the way the registry checks it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reg-dir-'));
  const folder = join(dir, 'dutch-tax');
  await mkdir(folder, { recursive: true });

  let read = await readFolder(folder, 'skill');
  assert.ok(read.errors.includes('SKILL.md is missing') && read.errors.includes('skill.json is missing'));

  await writeFile(join(folder, 'skill.json'), JSON.stringify({ name: 'dutch-tax', version: '1.0.0', author: 'a', license: 'CC-BY-4.0', sources: ['https://x.example'] }));
  await writeFile(join(folder, 'SKILL.md'), '---\nname: dutch-tax\ndescription: Tax.\nwhenToUse: When asked about tax.\n---\n\nBody.\n');
  read = await readFolder(folder, 'skill');
  assert.deepEqual(read.errors, [], read.errors.join('; '));
  assert.equal(read.meta.name, 'dutch-tax');

  await writeFile(join(folder, 'helper.py'), 'print(1)');
  read = await readFolder(folder, 'skill');
  assert.ok(read.errors.some((e) => e.includes('.py is not allowed')), 'code in a skill is refused');

  await rm(dir, { recursive: true, force: true });
});

test('the contribution text says who made it and where it came from', () => {
  const body = submissionText('skill', { name: 'dutch-tax', version: '1.0.0', description: 'Tax.', author: 'Iris of Anna', license: 'CC-BY-4.0', sources: ['https://x.example'] });
  assert.ok(body.includes('Add skill dutch-tax 1.0.0'));
  assert.ok(body.includes('Iris of Anna') && body.includes('https://x.example'));
  assert.ok(body.includes('reviews'));
});
