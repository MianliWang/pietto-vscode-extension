import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {commandArguments, debounce, fromWsl, isWslLauncher, migrateArguments, previewArguments, probe, probeArguments, projectPreviewArguments, projectsOf, projectTargetArguments, resolveRoots, serverArguments, strings, toWsl} from '../src/launch';
import {parseMigration, previewMigration, previewProjectSql, previewSql} from '../src/preview';
import {python, pythonArguments} from './editor';

const token = {onCancellationRequested: () => ({dispose() {}})};

test('migration preview passes a filename as an argument, never as Python source', () => {
  const source = "/work/it's old.pietto";
  const args = migrateArguments(['-d', 'Ubuntu', '--', '/venv/bin/python'], source);
  assert.deepEqual(args.slice(0, 3), ['-d', 'Ubuntu', '--']);
  assert.deepEqual(args.slice(-2), ['migrate', source]);
  assert.doesNotMatch(args[args.indexOf('-c') + 1], /it's old/);
  assert.ok(args.includes('-I'));
});

test('migration preview shows stdout only for a clean exit 0 and stderr for a refusal', () => {
  // The exact migrated bytes, a leading BOM and CRLF line ends included.
  assert.deepEqual(parseMigration(null, '\uFEFFshape S:\r\n    id: Int\r\n', ''), {status: 'ready', source: '\uFEFFshape S:\r\n    id: Int\r\n'});
  assert.deepEqual(parseMigration(null, '', ''), {status: 'ready', source: ''});
  assert.equal(parseMigration(null, 'shape S:\n', 'warning\n').status, 'failed');
  const refusal = 'old.pietto:1:1 PIE-P1011 error: The header line `mode strict` needs manual migration. No migrated source was emitted.';
  assert.deepEqual(parseMigration({code: 1, message: 'Command failed'}, 'partial source', `${refusal}\n`), {status: 'refused', message: `pietto migrate emitted no source: ${refusal}`});
  assert.deepEqual(parseMigration({code: 2, message: 'Command failed'}, '', 'old.pietto: error: No such file or directory (errno 2)\n'),
    {status: 'refused', message: 'pietto migrate emitted no source: old.pietto: error: No such file or directory (errno 2)'});
  const failures = [parseMigration({code: 1, message: 'Command failed'}, 'partial source', ''), parseMigration({code: 'ENOENT', message: 'spawn python ENOENT'}, '', ''),
    parseMigration({code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded'}, 'partial', '')];
  assert.deepEqual(failures.map(result => result.status), ['failed', 'failed', 'failed']);
  assert.ok(failures.every(result => result.status === 'failed' && !result.message.includes('partial')));
});

test('the real pietto migrate migrates retired spelling, refuses a manual case and writes no file', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-migrate-'));
  try {
    const old = path.join(directory, "it's old.pietto");
    const oldText = 'shape User:\n    id: Int not null\n    email: Text nullable\n\nsource users: User = postgres.table("public.users")\n';
    writeFileSync(old, oldText);
    assert.deepEqual(await previewMigration(python(), pythonArguments(), old, token),
      {status: 'ready', source: 'shape User:\n    id: Int\n    email: Text | None\n\nsource users: User = postgres.table("public.users")\n'});
    const manual = path.join(directory, 'manual.pietto');
    writeFileSync(manual, 'mode strict\nshape Legacy:\n    id: Int\n');
    const refused = await previewMigration(python(), pythonArguments(), manual, token);
    assert.equal(refused.status, 'refused');
    assert.match(refused.status === 'refused' ? refused.message : '', /^pietto migrate emitted no source: .*manual\.pietto:1:1 PIE-P1011 error: The header line `mode strict` needs manual migration/);
    assert.equal(readFileSync(old, 'utf8'), oldText);
    assert.equal(readFileSync(manual, 'utf8'), 'mode strict\nshape Legacy:\n    id: Int\n');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('an interpreter that cannot start fails a preview with its cause instead of throwing', async () => {
  const migration = await previewMigration('', [], 'old.pietto', token);
  assert.equal(migration.status, 'failed');
  assert.match(migration.status === 'failed' ? migration.message : '', /^"" could not be started: .*cannot be empty/);
  for (const result of [await previewSql('', [], 'one.pietto', 'mysql', token), await previewProjectSql('', [], {root: 'project', module: 'one.pietto', dialect: 'postgres', contract: 'contract.json'}, token)]) {
    assert.equal(result.status, 'failed');
    assert.match(result.status === 'failed' ? result.message : '', /^"" could not be started: .*cannot be empty/);
  }
});

test('a burst of restart triggers runs one restart after the last; cancel drops a pending one', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let restarts = 0;
  const restart = debounce(500, () => restarts++);
  restart.schedule();
  t.mock.timers.tick(400);
  restart.schedule();
  t.mock.timers.tick(400);
  restart.schedule();
  assert.equal(restarts, 0);
  t.mock.timers.tick(500);
  assert.equal(restarts, 1);
  t.mock.timers.tick(5000);
  assert.equal(restarts, 1);
  restart.schedule();
  restart.cancel();
  t.mock.timers.tick(5000);
  assert.equal(restarts, 1);
  restart.schedule();
  t.mock.timers.tick(500);
  assert.equal(restarts, 2);
});

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
  const all = projectTargetArguments(['-B'], {root: '-root', dialect: 'postgres', contract: 'contract.json'});
  assert.deepEqual(all.slice(all.indexOf('emit-sql')), ['emit-sql', '--project=-root', '--all', '--dialect=postgres', '--emission-contract=contract.json', '--format=json']);
  assert.deepEqual(all.slice(0, 2), ['-B', '-I']);
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
