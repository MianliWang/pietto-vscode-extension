import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {commandArguments, fromWsl, isWslLauncher, previewArguments, probe, probeArguments, projectPreviewArguments, projectsOf, resolveRoots, serverArguments, strings, toWsl} from '../src/launch';
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

test('SQL preview passes a filename as an argument, never as Python source', () => {
  const source = "/work/it's a query.pietto";
  const args = previewArguments(['-d', 'Ubuntu', '--', '/venv/bin/python'], [source], 'postgres');
  assert.deepEqual(args.slice(0, 3), ['-d', 'Ubuntu', '--']);
  assert.deepEqual(args.slice(args.indexOf('emit-sql')), ['emit-sql', source, '--dialect', 'postgres', '--format', 'json']);
  const script = args[args.indexOf('-c') + 1];
  assert.match(script, /sys\.argv\[1:\]/);
  assert.doesNotMatch(script, /it's a query/);
  assert.deepEqual(commandArguments([], ['emit-sql', source]).slice(-2), ['emit-sql', source]);
  assert.deepEqual(previewArguments([], [source], 'mysql').slice(-5), [source, '--dialect', 'mysql', '--format', 'json']);
});

test('project SQL preview runs the documented batch form for one module, each value joined to its option', () => {
  const args = projectPreviewArguments([], {root: "/work/it's a project", module: '-odd/main.pietto', dialect: 'mysql', contract: 'contracts/my sql.json'});
  assert.deepEqual(args.slice(args.indexOf('emit-sql')), ['emit-sql', "--project=/work/it's a project", '--all', '--module=-odd/main.pietto', '--dialect=mysql',
    '--emission-contract=contracts/my sql.json', '--format=json']);
  assert.doesNotMatch(args[args.indexOf('-c') + 1], /it's a project/);
});

test('a file belongs to each root that contains it, with its project-relative module path', () => {
  assert.deepEqual(projectsOf('/work/shop/models/main.pietto', ['/work/shop', '/work/shop/models', '/work/other'], false), [
    {root: '/work/shop', module: 'models/main.pietto'}, {root: '/work/shop/models', module: 'main.pietto'},
  ]);
  assert.deepEqual(projectsOf('/work/shop', ['/work/shop'], false), []);
  assert.deepEqual(projectsOf('/work/shopping/a.pietto', ['/work/shop'], false), []);
  assert.deepEqual(projectsOf('/work/shop/..data/a.pietto', ['/work/shop'], false), [{root: '/work/shop', module: '..data/a.pietto'}]);
  assert.deepEqual(projectsOf('/work/a.pietto', ['/work/shop'], false), []);
  assert.deepEqual(projectsOf('c:\\Work\\Shop\\models\\main.pietto', ['C:\\work\\shop'], true), [{root: 'C:\\work\\shop', module: 'models/main.pietto'}]);
  assert.deepEqual(projectsOf('D:\\shop\\main.pietto', ['C:\\shop'], true), []);
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
