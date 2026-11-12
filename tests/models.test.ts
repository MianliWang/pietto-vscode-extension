import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {explainArguments} from '../src/launch';
import {parseColumns, relationColumns} from '../src/models';
import {python, pythonArguments, root} from './editor';
import {fixture} from './runHost';

const columns = (fields: Record<string, unknown>) => JSON.stringify({cli_errors: [], diagnostics: [], format: 'pietto.project-relation-columns.v1', ok: true, relations: [], ...fields});
const int = (name: string, nullability = 'non_null') => ({name, nullability, type: {kind: 'builtin', name: 'Int'}});
const relation = (kind: string, name: string, items: unknown[], module = 'models/main.pietto') => ({columns: items, kind, module, name});
const warning = {code: 'PIE-S2385', location: null, message: 'untyped None', related_locations: [], severity: 'warning', suggestion: null};
const cannot = (reason: string) => [{label: `The extension cannot read the column view of this Pietto: ${reason}.`}];
const token = {onCancellationRequested: () => ({dispose() {}})};

test('the Models view lists the relations in document order, each column as name: Type with its nullability', () => {
  const stdout = columns({diagnostics: [warning], added: true, relations: [
    relation('query', 'later', [
      int('id'),
      {name: 'note', nullability: 'nullable', type: {kind: 'builtin', name: 'Text'}},
      int('t', 'unknown'),
      {name: 'level', nullability: 'non_null', type: {kind: 'enum', module: 'models/types.pietto', name: 'Tier'}},
      {name: 'addr', nullability: 'nullable', type: {kind: 'shape', module: 'models/types.pietto', name: 'Addr'}},
      {name: 'total', nullability: 'non_null', type: {kind: 'type_alias', name: 'Money'}},
      {name: 'odd', nullability: 'unknown', type: {kind: 'unknown', name: 'Odd'}},
      {name: 'recent', nullability: 'non_null', type: {kind: 'collection', name: null, element: [int('id'), {...int('code', 'nullable'), added: 1}]}},
    ], 'models/z.pietto'),
    relation('table', 'earlier', [], 'models/a.pietto'),
  ]});
  assert.deepEqual(parseColumns(stdout, 0), [
    {label: 'query later', description: 'models/z.pietto', children: [
      {label: 'id: Int', description: 'non_null'},
      {label: 'note: Text', description: 'nullable'},
      {label: 't: Int', description: 'unknown'},
      {label: 'level: Tier', description: 'non_null, enum from models/types.pietto'},
      {label: 'addr: Addr', description: 'nullable, shape from models/types.pietto'},
      {label: 'total: Money', description: 'non_null, type_alias'},
      {label: 'odd: Odd', description: 'unknown, unknown'},
      {label: 'recent: collection', description: 'non_null', children: [{label: 'id: Int', description: 'non_null'}, {label: 'code: Int', description: 'nullable'}]},
    ]},
    {label: 'table earlier', description: 'models/a.pietto', children: []},
  ]);
  assert.deepEqual(parseColumns(columns({}), 0), [{label: 'The project has no tables or queries.'}]);
});

test('a failed project shows its CLI errors and how many diagnostics Problems has, and no relation', () => {
  const error = {code: 'PIE-S2102', location: null, message: 'Unknown field: emial', related_locations: [], severity: 'error', suggestion: null};
  assert.deepEqual(parseColumns(columns({ok: false, relations: null, diagnostics: [error, error]}), 1), [{label: 'The project check did not pass: 2 diagnostics, see Problems.'}]);
  const unavailable = {kind: 'project_resource', message: 'Project relation columns are unavailable.', path: null};
  assert.deepEqual(parseColumns(columns({ok: false, relations: null, diagnostics: [warning], cli_errors: [unavailable]}), 2), [
    {label: 'project error: project_resource: Project relation columns are unavailable.'}, {label: '1 diagnostic, see Problems.'}]);
  assert.deepEqual(parseColumns(columns({ok: false, relations: null, cli_errors: [{kind: 'project_root', message: 'Project root is missing.', path: null}, unavailable]}), 2), [
    {label: 'project error: project_root: Project root is missing.'}, {label: 'project error: project_resource: Project relation columns are unavailable.'}]);
});

test('pietto.project-explain.v1 is a schema_version 4 project on success and its errors on failure', () => {
  const explain = (fields: Record<string, unknown>) => JSON.stringify({format: 'pietto.project-explain.v1', ok: true, diagnostics: [], payload: {}, ...fields});
  assert.deepEqual(parseColumns(explain({}), 0), [{label: 'This is a schema_version 4 project; Pietto lists relation columns only for schema_version 2.'}]);
  const location = {path: {kind: 'project_relative', value: 'pietto.toml'}, line: null, column: null, end_line: null, end_column: null};
  assert.deepEqual(parseColumns(explain({ok: false, payload: null, diagnostics: [
    {code: 'config_parse', severity: 'error', message: 'Project configuration TOML is invalid.', location, suggestion: null},
    {code: 'project_root', severity: 'error', message: 'Project root does not exist or is not accessible.', location: null, suggestion: null},
  ]}), 2), [
    {label: 'project error: config_parse: Project configuration TOML is invalid.'},
    {label: 'project error: project_root: Project root does not exist or is not accessible.'},
  ]);
  assert.deepEqual(parseColumns(explain({ok: false, payload: null}), 2), cannot('ok false without a diagnostic'));
});

test('anything the view cannot read replaces the whole root, never part of it', () => {
  const good = relation('table', 'fine', [int('id')]);
  const odd = (column: unknown) => columns({relations: [good, relation('query', 'q', [int('id'), column])]});
  for (const [stdout, exit, reason] of [
    ['{', 0, 'the output is not JSON'],
    ['[]', 0, 'the output is not a JSON object'],
    [columns({format: 'pietto.project-relation-columns.v2'}), 0, 'unknown format "pietto.project-relation-columns.v2"'],
    [JSON.stringify({ok: true, relations: []}), 0, 'unknown format undefined'],
    [odd({name: 'x', nullability: 'non_null', type: {kind: 'decimal', name: 'Decimal'}}), 0, 'unknown type kind "decimal"'],
    [odd({name: 'x', nullability: 'maybe', type: {kind: 'builtin', name: 'Int'}}), 0, 'unknown nullability "maybe"'],
    [odd({name: 'x', nullability: 'non_null'}), 0, 'a column is not an object with a type'],
    [odd({name: 7, nullability: 'non_null', type: {kind: 'builtin', name: 'Int'}}), 0, 'a column name is not a string'],
    [odd({name: 'x', nullability: 'non_null', type: {kind: 'enum', name: 'Tier'}}), 0, 'a type module is not a string'],
    [odd({name: 'x', nullability: 'non_null', type: {kind: 'collection', name: null, element: [{name: 'y', nullability: 'non_null', type: {kind: 'collection', name: null, element: []}}]}}), 0, 'a collection inside a collection'],
    [odd({name: 'x', nullability: 'non_null', type: {kind: 'collection', name: null}}), 0, 'a collection element is not a list'],
    [columns({relations: [good, relation('view', 'v', [])]}), 0, 'unknown relation kind "view"'],
    [columns({relations: [good, {kind: 'query', name: 'q', module: 'm.pietto'}]}), 0, 'the columns of a relation is not a list'],
    [columns({}), 1, 'exit code 1 with ok true'],
    [columns({}), null, 'exit code null with ok true'],
    [columns({ok: false, relations: null, diagnostics: [warning]}), 0, 'exit code 0 with ok false'],
    [columns({ok: false, relations: null, diagnostics: [warning]}), 3, 'exit code 3 with ok false'],
    [columns({ok: 'yes'}), 0, 'exit code 0 with ok "yes"'],
    [columns({ok: false, relations: [], diagnostics: [warning]}), 1, 'relations with ok false'],
    [columns({ok: false, relations: null}), 1, 'ok false without a diagnostic or CLI error'],
    [columns({cli_errors: [{kind: 'usage', message: 'odd', path: null}]}), 0, 'CLI errors with ok true'],
    [columns({diagnostics: null}), 0, 'diagnostics is not a list'],
  ] as const) assert.deepEqual(parseColumns(stdout, exit), cannot(reason), stdout);
});

test('names, paths and messages keep to one line: controls are escaped as Pietto escapes text', () => {
  const stdout = columns({relations: [relation('query', 'q\n', [int('a\x7fb')], 'models/a‮\u0085.pietto')]});
  assert.deepEqual(parseColumns(stdout, 0), [{label: 'query q\\x0a', description: 'models/a\\u202e\\u0085.pietto', children: [{label: 'a\\x7fb: Int', description: 'non_null'}]}]);
  assert.deepEqual(parseColumns(columns({ok: false, relations: null, cli_errors: [{kind: 'project_path', message: 'bad path', path: null}]}), 2), [{label: 'project error: project_path: bad\\u2028path'}]);
  assert.deepEqual(parseColumns(columns({format: 'odd\nformat'}), 0), cannot('unknown format "odd\\nformat"'));
});

test('explain runs with each value joined to its option, and its error output, size and cancellation are checked', {skip: process.platform === 'win32' && 'the stand-in interpreters are POSIX shell scripts'}, async () => {
  assert.deepEqual(explainArguments(['-d', 'Ubuntu', '--', '/venv/bin/python'], "/work/it's -a root").slice(-3), ['explain', "--project=/work/it's -a root", '--format=json']);
  assert.ok(explainArguments([], '/r').includes('-I'));
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-models-'));
  try {
    const script = (name: string, body: string) => {
      const file = path.join(directory, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`, {mode: 0o755});
      return file;
    };
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const argv = path.join(directory, 'argv');
    const echo = script('echo', `printf '%s\\n' "$@" > ${quote(argv)}\nprintf '%s\\n' ${quote(columns({}))}`);
    assert.deepEqual(await relationColumns(echo, ['-B'], '/work/root', token), [{label: 'The project has no tables or queries.'}]);
    assert.deepEqual(readFileSync(argv, 'utf8').split('\n').slice(0, -1), explainArguments(['-B'], '/work/root'));
    const noisy = script('noisy', `printf '%s\\n' ${quote(columns({}))}\necho 'Traceback: boom' >&2`);
    assert.deepEqual(await relationColumns(noisy, [], '/r', token), [{label: 'Pietto explain --project wrote unexpected error output: Traceback: boom'}]);
    const large = script('large', `head -c ${64 * 1024 * 1024 + 1} /dev/zero`);
    assert.deepEqual(await relationColumns(large, [], '/r', token), [{label: 'Pietto explain --project wrote more than 64 MiB.'}]);
    assert.deepEqual(await relationColumns(path.join(directory, 'missing'), [], '/r', token), [{label: 'Pietto explain --project stopped before it completed.'}]);
    assert.match((await relationColumns('', [], '/r', token))?.[0].label ?? '', /^"" could not be started: The argument 'file' cannot be empty/);
    // A cancelled run stops its process and has no result.
    const pid = path.join(directory, 'pid');
    const slow = script('slow', `echo $$ > ${quote(pid)}\nexec sleep 30`);
    let cancel = () => {};
    const cancellable = {onCancellationRequested: (listener: () => void) => { cancel = listener; return {dispose() {}}; }};
    const started = Date.now();
    const running = relationColumns(slow, [], '/r', cancellable);
    while (!existsSync(pid) || !readFileSync(pid, 'utf8').trim()) await new Promise(resolve => setTimeout(resolve, 20));
    cancel();
    assert.equal(await running, undefined);
    assert.ok(Date.now() - started < 10_000);
    assert.throws(() => process.kill(Number(readFileSync(pid, 'utf8')), 0), {code: 'ESRCH'});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

// What the real pietto explain --project prints for a root, read independently of the view.
const explained = (project: string) => new Promise<{relations: {kind: string; name: string}[] | null}>((resolve, reject) =>
  execFile(python(), explainArguments(pythonArguments(), project), {encoding: 'utf8'}, (_error, stdout) => { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }));
const id = {label: 'id: Int', description: 'non_null'};

test('the real pietto explain --project lists the example project and the host emit project, item by item', async () => {
  const example = path.join(root, 'examples', 'project');
  const nodes = await relationColumns(python(), pythonArguments(), example, token);
  assert.deepEqual(nodes, [
    {label: 'query joined', description: 'models/joined.pietto', children: [
      {label: 'account_id: Int', description: 'non_null'}, {label: 'event_id: Int', description: 'nullable'},
      {label: 'bound_key: Int', description: 'nullable'}, {label: 'ranked: Int', description: 'non_null'}]},
    {label: 'query emails', description: 'models/emails.pietto', children: [id, {label: 'email: Text', description: 'nullable'}]},
  ]);
  assert.deepEqual(nodes?.map(node => node.label), (await explained(example)).relations?.map(item => `${item.kind} ${item.name}`));
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-models-'));
  try {
    const project = path.join(directory, "it's a project");
    const write = (name: string, text: string) => {
      mkdirSync(path.dirname(path.join(project, name)), {recursive: true});
      writeFileSync(path.join(project, name), text);
    };
    for (const [name, text] of Object.entries(fixture)) if (name.startsWith('emit/')) write(name.slice('emit/'.length), text);
    const emitted = await relationColumns(python(), pythonArguments(), project, token);
    assert.deepEqual(emitted, [
      {label: 'table active_items', description: 'models/items.pietto', children: [id, {label: 'label: Text', description: 'non_null'}]},
      {label: 'query small_items', description: 'models/items.pietto', children: [id]},
      {label: 'query large_items', description: 'models/blocked.pietto', children: [id]},
    ]);
    assert.deepEqual(emitted?.map(node => node.label), (await explained(project)).relations?.map(item => `${item.kind} ${item.name}`));
    // Enum and shape columns name their declaring module; a collection lists its element columns.
    write('models/types.pietto', 'enum Tier:\n    gold\n    silver\n\nshape Addr:\n    city: Text\n\nexport (\n    enum Tier,\n    shape Addr)\n');
    write('models/accounts.pietto', 'from "models/types.pietto" import (\n    enum Tier as Level,\n    shape Addr)\n\nshape Acct:\n    id: Int\n    level: Level\n    addr: Addr\n    note: Text | None\n\n'
      + 'source accts: Acct = postgres.table("accts")\n\nsource notes: Acct = postgres.table("notes")\n\nquery typed:\n    from accts\n    select:\n        level\n        addr\n\n'
      + 'query with_notes:\n    let recent:\n        capture accts\n        from notes\n        where notes.id == accts.id\n        select:\n            id\n            note\n        order by id\n    from accts\n    select:\n        id\n        recent_notes = collect recent\n');
    const typed = await relationColumns(python(), pythonArguments(), project, token);
    const [typedNode, collected] = (typed ?? []).filter(node => node.description === 'models/accounts.pietto');
    assert.deepEqual(typedNode, {label: 'query typed', description: 'models/accounts.pietto', children: [
      {label: 'level: Tier', description: 'non_null, enum from models/types.pietto'}, {label: 'addr: Addr', description: 'non_null, shape from models/types.pietto'}]});
    assert.deepEqual(collected, {label: 'query with_notes', description: 'models/accounts.pietto', children: [id,
      {label: 'recent_notes: collection', description: 'non_null', children: [id, {label: 'note: Text', description: 'nullable'}]}]});
    assert.deepEqual(typed?.map(node => node.label), (await explained(project)).relations?.map(item => `${item.kind} ${item.name}`));
    // A module with an error: no relation, only the count of its diagnostics.
    write('models/broken.pietto', 'from "models/items.pietto" import (\n    source items)\n\nquery broken:\n    from items\n    select:\n        emial\n');
    assert.deepEqual(await relationColumns(python(), pythonArguments(), project, token), [{label: 'The project check did not pass: 1 diagnostic, see Problems.'}]);
    assert.deepEqual(await relationColumns(python(), pythonArguments(), path.join(directory, 'none'), token),
      [{label: 'project error: project_root: Project root does not exist or is not accessible.'}]);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
