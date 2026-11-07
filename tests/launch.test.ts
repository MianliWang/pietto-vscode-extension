import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fromWsl, isWslLauncher, probe, probeArguments, resolveRoots, serverArguments, strings, toWsl} from '../src/launch';
import {python, pythonArguments} from './editor';

test('the server runs the pietto console entry point in isolated mode after the launcher arguments', () => {
  assert.deepEqual(serverArguments(['-d', 'Ubuntu', '--', '/venv/bin/python']), [
    '-d', 'Ubuntu', '--', '/venv/bin/python', '-I', '-c', "import sys; from pietto.cli import main; sys.exit(main(['lsp']))",
  ]);
  assert.deepEqual(probeArguments([]).slice(0, 2), ['-I', '-c']);
  assert.match(probeArguments([]).at(-1)!, /main\(\['lsp', '--help'\]\)/);
  // The script carries no double quote, dollar sign, backtick or backslash for a shell to rewrite.
  assert.doesNotMatch(serverArguments([]).at(-1)!, /["$`\\]/);
});

test('the server script is valid Python', () => {
  const help = execFileSync(python(), probeArguments(pythonArguments()), {encoding: 'utf8'});
  assert.match(help, /usage: pietto lsp/);
});

test('the probe resolves with the cause of a failure, including one that stops the interpreter from starting', async () => {
  // Node stands in for the interpreter: it runs the -e script and takes the probe's own arguments after -- as its argv.
  const fake = (script: string) => ['-e', script, '--'];
  assert.equal(await probe(process.execPath, fake('process.exit(0)')), undefined);
  assert.equal(await probe(process.execPath, fake("console.error('Traceback'); console.error(\"ModuleNotFoundError: No module named 'pietto'\"); process.exit(1)")),
    "ModuleNotFoundError: No module named 'pietto'");
  assert.equal(await probe(process.execPath, fake("process.stderr.write(Buffer.from('There is no distribution with the supplied name.\\r\\n', 'utf16le')); process.exit(1)")),
    'There is no distribution with the supplied name.');
  assert.match((await probe('', []))!, /cannot be empty/);
});

test('list settings keep their strings; any other value is empty', () => {
  assert.deepEqual(strings(['-d', 3, 'Ubuntu', null]), ['-d', 'Ubuntu']);
  assert.deepEqual(strings('-S'), []);
  assert.deepEqual(strings(undefined), []);
});

test('project roots resolve against their workspace folder, keep order and drop duplicates', () => {
  assert.deepEqual(resolveRoots([
    ['/work/a', ['.', 'models/', 'models', '/abs/root', '', 3, '../b']],
    ['/work/b', ['.']],
    ['/work/c', 'not a list'],
  ], false), ['/work/a', '/work/a/models', '/abs/root', '/work/b']);
  assert.deepEqual(resolveRoots([['C:\\Work\\a', ['.', 'Models', 'c:\\work\\a\\models', 'D:\\other']]], true), ['C:\\Work\\a', 'C:\\Work\\a\\Models', 'D:\\other']);
  assert.deepEqual(resolveRoots([], false), []);
});

test('a wsl.exe launcher maps drive paths to /mnt and back', () => {
  assert.equal(isWslLauncher('C:\\Windows\\System32\\wsl.exe', 'win32'), true);
  assert.equal(isWslLauncher('wsl', 'win32'), true);
  assert.equal(isWslLauncher('/usr/bin/wsl', 'linux'), false);
  assert.equal(isWslLauncher('C:\\Python313\\python.exe', 'win32'), false);
  assert.equal(toWsl('c:\\Users\\ada\\work\\harbor-sales'), '/mnt/c/Users/ada/work/harbor-sales');
  assert.equal(toWsl('D:/data/'), '/mnt/d/data');
  assert.equal(toWsl('C:\\'), '/mnt/c');
  assert.equal(toWsl('\\\\server\\share\\x'), '\\\\server\\share\\x');
  assert.equal(fromWsl('/mnt/c/Users/ada/a.pietto'), 'c:/Users/ada/a.pietto');
  assert.equal(fromWsl('/mnt/d'), 'd:/');
  assert.equal(fromWsl('/home/ada/a.pietto'), undefined);
  assert.equal(fromWsl(toWsl('c:\\Users\\ada\\a.pietto')), 'c:/Users/ada/a.pietto');
});
