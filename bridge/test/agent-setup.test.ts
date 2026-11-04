import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { npmCommand } from '../src/agent-setup.js';

test('source setup uses the npm that launched Maestro when no bundled runtime exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'maestro-npm-'));
  try {
    const npm = join(root, 'npm-cli.js');
    writeFileSync(npm, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const command = npmCommand(root, { npm_execpath: npm, PATH: '' });
    const args = ['install', '--prefix', join(root, 'agents'), '@openai/codex@0.160.0'];
    assert.deepEqual(JSON.parse(execFileSync(command.binary, [...command.args, ...args], { encoding: 'utf8' })), args);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the packaged app uses its bundled npm even when the shell has another npm', () => {
  const root = mkdtempSync(join(tmpdir(), 'maestro-npm-'));
  try {
    const npm = join(root, '.tools/node/lib/node_modules/npm/bin/npm-cli.js');
    mkdirSync(join(npm, '..'), { recursive: true });
    writeFileSync(npm, 'process.stdout.write("bundled")');
    const command = npmCommand(root, { npm_execpath: '/missing/npm-cli.js', PATH: '' });
    assert.equal(execFileSync(command.binary, command.args, { encoding: 'utf8' }), 'bundled');
    assert.throws(() => npmCommand(join(root, 'missing'), { PATH: '' }), /npm is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
