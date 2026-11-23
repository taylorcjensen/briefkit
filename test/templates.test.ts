import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeTempDir } from './helpers/process.ts';

const root = path.resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const tsxImport = createRequire(import.meta.url).resolve('tsx/esm');

async function invoke(args: string[], cwd: string, home: string) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', tsxImport, path.join(root, 'bin', 'briefkit.js'), ...args], {
      cwd, env: { ...process.env, HOME: home, BRIEFKIT_TSX_RUN: '1', NO_COLOR: '1' }, maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

async function sandbox() {
  const directory = await makeTempDir('templates');
  const home = path.join(directory, 'home');
  const cwd = path.join(directory, 'work');
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  const config = path.join(home, '.config', 'briefkit', 'templates');
  const run = (args: string[]) => invoke(['templates', ...args], cwd, home);
  return { directory, home, cwd, config, run };
}

test('local file templates can be initialized, listed, edited and copied without clobbering', async () => {
  const { cwd, config, run } = await sandbox();
  const empty = await run(['list']);
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.match(empty.stdout, /No templates/);
  await assert.rejects(fs.access(config)); // list must not seed the directory

  const initialized = await run(['init', 'decision']);
  assert.equal(initialized.exitCode, 0, initialized.stderr);
  assert.match((await run(['list'])).stdout, /decision \(Markdown\)/);
  await fs.writeFile(path.join(config, 'decision.md'), '# My edited decision\n');
  const used = await run(['use', 'decision', 'copy with spaces.md']);
  assert.equal(used.exitCode, 0, used.stderr);
  assert.equal(await fs.readFile(path.join(cwd, 'copy with spaces.md'), 'utf8'), '# My edited decision\n');
  const repeat = await run(['use', 'decision', 'copy with spaces.md']);
  assert.notEqual(repeat.exitCode, 0);
  assert.equal(await fs.readFile(path.join(cwd, 'copy with spaces.md'), 'utf8'), '# My edited decision\n');
  assert.notEqual((await run(['init', 'decision', '--folder'])).exitCode, 0);
  assert.notEqual((await run(['init', '../escape'])).exitCode, 0);
  assert.notEqual((await run(['use', 'decision', 'missing/dir/file.md'])).exitCode, 0);
  await fs.symlink(path.join(cwd, 'copy with spaces.md'), path.join(cwd, 'linked.md'));
  assert.notEqual((await run(['use', 'decision', 'linked.md'])).exitCode, 0);
  assert.equal(await fs.readFile(path.join(cwd, 'copy with spaces.md'), 'utf8'), '# My edited decision\n');
});

test('report folders copy recursively with intact sources and refuse existing targets and symlinks', async () => {
  const { cwd, config, run } = await sandbox();
  assert.equal((await run(['init', 'report', '--folder'])).exitCode, 0);
  await fs.mkdir(path.join(config, 'report', 'public'));
  await fs.writeFile(path.join(config, 'report', 'public', 'diagram.txt'), 'asset');
  const used = await run(['use', 'report']);
  assert.equal(used.exitCode, 0, used.stderr);
  assert.match(await fs.readFile(path.join(cwd, 'report', 'index.md'), 'utf8'), /Decision:/);
  assert.equal(await fs.readFile(path.join(cwd, 'report', 'public', 'diagram.txt'), 'utf8'), 'asset');
  assert.notEqual((await run(['use', 'report'])).exitCode, 0);
  await fs.symlink(path.join(cwd, 'report', 'index.md'), path.join(config, 'report', 'linked.md'));
  const rejected = await run(['use', 'report', 'other-report']);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /symlinks/);
  await assert.rejects(fs.access(path.join(cwd, 'other-report')));
});

test('explicit GitHub example installation produces a runnable local report with no implicit seeding', async () => {
  const { cwd, config, run, home } = await sandbox();
  const installed = await run(['install', path.join(root, 'examples', 'comparison')]);
  assert.equal(installed.exitCode, 0, installed.stderr);
  assert.match((await run(['list'])).stdout, /comparison \(folder\)/);
  assert.notEqual((await run(['install', path.join(root, 'examples', 'comparison')])).exitCode, 0);
  assert.equal((await run(['use', 'comparison', 'my-report'])).exitCode, 0);
  const build = await invoke(['build', path.join(cwd, 'my-report'), '--out', path.join(cwd, 'site')], cwd, home);
  assert.equal(build.exitCode, 0, build.stderr);
  const html = await fs.readFile(path.join(cwd, 'site', 'index.html'), 'utf8');
  assert.match(html, /Pick a static report site/);
  assert.match(html, /Decision rules/);
  assert.equal(await fs.readFile(path.join(config, 'comparison', 'index.md'), 'utf8'), await fs.readFile(path.join(cwd, 'my-report', 'index.md'), 'utf8'));
});

test('Markdown files can be installed with a new name, without rewriting either copy', async () => {
  const { cwd, config, run } = await sandbox();
  const source = path.join(cwd, 'source.md');
  await fs.writeFile(source, '# Personal source\n');
  assert.equal((await run(['install', source, 'personal'])).exitCode, 0);
  assert.equal((await run(['use', 'personal'])).exitCode, 0);
  assert.equal(await fs.readFile(path.join(cwd, 'personal.md'), 'utf8'), '# Personal source\n');
  assert.equal(await fs.readFile(path.join(config, 'personal.md'), 'utf8'), '# Personal source\n');
});
