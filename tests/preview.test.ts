import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {projectPreviewArguments, ProjectRequest} from '../src/launch';
import {parsePreview, parseProjectPreview, previewProjectSql, previewSql, ProjectPreviewResult, showIfCurrent} from '../src/preview';
import {python, pythonArguments} from './editor';

const envelope = (fields: Record<string, unknown>) => JSON.stringify({schema_version: 1, command: 'emit-sql', ok: true, path: 'one.pietto', dialect: 'postgres', output: null, diagnostics: [], cli_errors: [], artifacts: [], ...fields});

test('single-file SQL preview accepts only the emit-sql v1 envelope of the requested dialect and preserves artifact order', () => {
  const artifacts = [{kind: 'query', name: 'first', sql: 'SELECT 1'}, {kind: 'table', name: 'second', sql: 'SELECT 2'}];
  assert.deepEqual(parsePreview(envelope({artifacts}), 'postgres'), {status: 'ready', artifacts});
  assert.deepEqual(parsePreview(envelope({dialect: 'mysql', artifacts}), 'mysql', 'one.pietto'), {status: 'ready', artifacts});
  assert.deepEqual(parsePreview(envelope({ok: false, diagnostics: [{code: 'PIE-B1003', message: 'not admitted'}], artifacts: [{kind: 'query', name: 'forbidden', sql: 'SELECT secret'}]}), 'postgres'),
    {status: 'refused', message: 'PIE-B1003: not admitted'});
  assert.deepEqual(parsePreview(envelope({ok: false, dialect: 'mysql'}), 'mysql'), {status: 'refused', message: 'Pietto refused to emit MySQL SQL.'});
  assert.deepEqual(parsePreview('{', 'mysql'), {status: 'failed', message: 'Pietto did not return valid JSON for MySQL SQL preview.'});
  assert.equal(parsePreview(envelope({schema_version: 2}), 'postgres').status, 'failed');
  assert.equal(parsePreview(envelope({path: 'other.pietto'}), 'postgres', 'one.pietto').status, 'failed');
  assert.deepEqual(parsePreview(envelope({ok: false, path: null, diagnostics: [{code: 'usage', message: 'missing input'}]}), 'postgres', 'one.pietto'),
    {status: 'refused', message: 'usage: missing input'});
  assert.equal(parsePreview(JSON.stringify({schema_version: 1, command: 'emit-sql', ok: true, path: 'one.pietto', diagnostics: [], cli_errors: [], artifacts: []}), 'postgres').status, 'failed');
  assert.equal(parsePreview(envelope({dialect: 'mysql'}), 'postgres').status, 'failed');
  assert.equal(parsePreview(envelope({}), 'mysql').status, 'failed');
  assert.equal(parsePreview(envelope({output: 'out.sql'}), 'postgres').status, 'failed');
  // A later Pietto may add fields; the preview reads only the ones it shows.
  assert.deepEqual(parsePreview(envelope({added: {any: 1}, artifacts: [{kind: 'query', name: 'q', sql: 'SELECT 1', added: true}]}), 'postgres'),
    {status: 'ready', artifacts: [{kind: 'query', name: 'q', sql: 'SELECT 1'}]});
});

test('SQL preview does not show a document that becomes stale while it opens', async () => {
  let resolve: ((document: string) => void) | undefined;
  const opening = new Promise<string>(done => { resolve = done; });
  let current = true;
  const shown: string[] = [];
  const result = showIfCurrent(() => opening, () => current, async document => { shown.push(document); });
  current = false;
  resolve?.('SQL');
  assert.equal(await result, false);
  assert.deepEqual(shown, []);
});

// Documents in the shapes that pietto 0.1.10 prints, with a field a later Pietto might add.
const owner = (kind: string, name: string, module = 'models/main.pietto') => ({kind, module, name});
const verified = (sql: string, family = 'postgres', format = 'pietto.sql-emission.v1') => ({format, status: 'VERIFIED', sql, target: {family, release: '18.6', environment: []},
  request: {}, columns: [], diagnostics: [], fixed_values: [], parameter_uses: [], ranges: [], requirements: [], added: 'ignored'});
const failure = (status: string, fields: Record<string, unknown>) => ({format: 'pietto.sql-emission.v1', status, artifact: null, blockers: [], cli_errors: [], diagnostics: [], ...fields});
const blocker = {code: 'PIE-B1004', location: null, reason: 'MISSING_EVIDENCE', related: [], subject: {detail: 'identifier_case_declaration_missing', reference: {kind: 'selected_plan', position: 0}},
  suggestion: 'add {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"'};
const located = {code: 'PIE-B1003', location: {path: 'models/main.pietto', line: 3, column: 5, end_line: 3, end_column: 9}, reason: 'UNSUPPORTED_RULE',
  related: [{path: 'models/other.pietto', line: 1, column: 2, end_line: 1, end_column: 6}, {path: null, line: 1, column: 1, end_line: 1, end_column: 1}, {path: 'models/main.pietto', line: 7, column: 1, end_line: 7, end_column: 4}],
  subject: {detail: 'set_row_equivalence_domain_unsupported'}, suggestion: 'use UNION ALL'};
const diagnostic = {code: 'PIE-S2102', severity: 'error', message: 'Unknown field: emial', location: {path: 'models/main.pietto', line: 26, column: 9, end_line: 26, end_column: 14}, suggestion: null};
const batch = (status: string, items: unknown[], failed: unknown = null) => JSON.stringify({format: 'pietto.sql-emission.batch.v1', status, items, failure: failed, added: []});
const item = (kind: string, name: string, document: unknown, module?: string) => ({owner: owner(kind, name, module), path: 'artifacts/000000.json', document});

test('project SQL preview lists every batch item in order, with the exact SQL or Pietto\'s text presentation of a refused document', () => {
  const v2 = verified('SELECT $1', 'postgres', 'pietto.sql-emission.v2');
  const stdout = batch('INPUT_REJECTED', [
    item('table', 'active_items', verified('SELECT "s0"."item_id" AS "id"')),
    item('query', 'small_items', failure('BLOCKED', {blockers: [blocker, located], diagnostics: [{...diagnostic, severity: 'warning', suggestion: 'check it'}]})),
    item('query', 'since', v2),
    item('query', 'odd', failure('INPUT_REJECTED', {cli_errors: [{kind: 'emission_contract_schema', message: 'Emission contract target family conflicts with --dialect.', path: 'target/family'}]})),
  ]);
  assert.deepEqual(parseProjectPreview(stdout, 2, 'models/main.pietto', 'postgres'), {status: 'ready', items: [
    {kind: 'table', name: 'active_items', status: 'VERIFIED', text: 'SELECT "s0"."item_id" AS "id"'},
    {kind: 'query', name: 'small_items', status: 'BLOCKED', text: [
      'query small_items in models/main.pietto, PostgreSQL',
      'pietto.sql-emission.v1 BLOCKED',
      'blocker PIE-B1004 MISSING_EVIDENCE: identifier_case_declaration_missing',
      '  hint: add {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"',
      'blocker PIE-B1003 UNSUPPORTED_RULE: set_row_equivalence_domain_unsupported (models/main.pietto:3:5)',
      '  related: models/other.pietto:1:2, models/main.pietto:7:1',
      '  hint: use UNION ALL',
      'models/main.pietto:26:9 PIE-S2102 warning: Unknown field: emial',
      ''].join('\n')},
    {kind: 'query', name: 'since', status: 'VERIFIED', text: 'SELECT $1'},
    {kind: 'query', name: 'odd', status: 'INPUT_REJECTED', text: [
      'query odd in models/main.pietto, PostgreSQL',
      'pietto.sql-emission.v1 INPUT_REJECTED',
      'error emission_contract_schema: Emission contract target family conflicts with --dialect. (path: target/family)',
      ''].join('\n')},
  ]});
});

test('a project SQL report keeps Pietto\'s order and escapes controls so each entry stays one line', () => {
  const odd = 'models/a\nb\u202e\u0085\x7f.pietto';
  const document = failure('INPUT_REJECTED', {
    diagnostics: [{...diagnostic, message: 'tab\there', location: {...diagnostic.location, path: odd}}, {...diagnostic, location: {path: null, line: 1, column: 1}}],
    blockers: [{...located, location: {...located.location, path: odd}, related: [{path: odd, line: 2, column: 3}], subject: {detail: 'line\u2028break'}, suggestion: 'see \u2066x\u2069'}],
    cli_errors: [{kind: 'project_path', message: `Path ${odd} is not allowed.`, path: odd}, {kind: 'usage', message: 'missing', path: null}],
  });
  const escaped = 'models/a\\x0ab\\u202e\\u0085\\x7f.pietto';
  assert.deepEqual(parseProjectPreview(batch('INPUT_REJECTED', [item('query', 'q\n', document, odd)]), 2, odd, 'mysql'), {status: 'ready', items: [{kind: 'query', name: 'q\n', status: 'INPUT_REJECTED', text: [
    `query q\\x0a in ${escaped}, MySQL`,
    'pietto.sql-emission.v1 INPUT_REJECTED',
    `error project_path: Path ${escaped} is not allowed. (path: ${escaped})`,
    'error usage: missing',
    `blocker PIE-B1003 UNSUPPORTED_RULE: line\\u2028break (${escaped}:3:5)`,
    `  related: ${escaped}:2:3`,
    '  hint: see \\u2066x\\u2069',
    `${escaped}:26:9 PIE-S2102 error: tab\\x09here`,
    'None:1:1 PIE-S2102 error: Unknown field: emial',
    ''].join('\n')}]});
});

test('project SQL preview shows a whole-project BLOCKED document as a report and an input refusal as its messages', () => {
  assert.deepEqual(parseProjectPreview(batch('BLOCKED', [], failure('BLOCKED', {diagnostics: [diagnostic]})), 1, 'models/main.pietto', 'mysql'), {status: 'blocked', report: [
    'models/main.pietto, MySQL', 'pietto.sql-emission.v1 BLOCKED', 'models/main.pietto:26:9 PIE-S2102 error: Unknown field: emial', ''].join('\n')});
  assert.deepEqual(parseProjectPreview(batch('INPUT_REJECTED', [], failure('INPUT_REJECTED', {cli_errors: [{kind: 'emission_contract_read', message: 'Emission contract file could not be opened inside the project root.', path: 'nope.json'}]})), 2, 'models/main.pietto', 'postgres'),
    {status: 'refused', message: 'error emission_contract_read: Emission contract file could not be opened inside the project root. (path: nope.json)'});
  assert.deepEqual(parseProjectPreview(batch('INPUT_REJECTED', [], failure('INPUT_REJECTED', {cli_errors: [{kind: 'emission_selector', message: 'No public project owner matches the supplied selectors.', path: null}]})), 2, 'models/main.pietto', 'postgres'),
    {status: 'refused', message: 'error emission_selector: No public project owner matches the supplied selectors.'});
  assert.deepEqual(parseProjectPreview(batch('INPUT_REJECTED', [], failure('INPUT_REJECTED', {})), 2, 'models/main.pietto', 'postgres'),
    {status: 'refused', message: 'Pietto refused to emit project PostgreSQL SQL.'});
});

test('project SQL preview fails closed on an unknown, incomplete or mismatched batch', () => {
  const good = [item('table', 't', verified('SELECT 1'))];
  const failed = (stdout: string, exit: number | null = 0, module = 'models/main.pietto') => {
    const result = parseProjectPreview(stdout, exit, module, 'postgres');
    assert.equal(result.status, 'failed', stdout);
    return result.status === 'failed' ? result.message : '';
  };
  assert.equal(parseProjectPreview(batch('VERIFIED', good), 0, 'models/main.pietto', 'postgres').status, 'ready');
  assert.equal(failed('{'), 'Pietto did not return valid JSON for project PostgreSQL SQL preview.');
  assert.equal(failed(JSON.stringify({format: 'pietto.sql-emission.batch.v2', status: 'VERIFIED', items: good, failure: null})), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('DONE', good)), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(JSON.stringify({format: 'pietto.sql-emission.batch.v1', status: 'VERIFIED', items: good})), 'Pietto returned an unsupported project emit-sql JSON response.');
  // The exit code must be the one the batch status documents: 0, 1 or 2.
  assert.equal(failed(batch('VERIFIED', good), 1), 'Pietto stopped before project PostgreSQL SQL preview completed.');
  assert.equal(failed(batch('VERIFIED', good), null), 'Pietto stopped before project PostgreSQL SQL preview completed.');
  assert.equal(failed(batch('BLOCKED', good), 0), 'Pietto stopped before project PostgreSQL SQL preview completed.');
  assert.equal(failed(batch('VERIFIED', [item('table', 't', verified('SELECT 1', 'postgres', 'pietto.sql-emission.v3'))])), 'Pietto returned an invalid SQL emission item.');
  assert.equal(failed(batch('VERIFIED', [item('table', 't', {...verified('SELECT 1'), sql: null})])), 'Pietto returned an invalid SQL emission item.');
  assert.equal(failed(batch('BLOCKED', [item('table', 't', {...failure('BLOCKED', {}), blockers: undefined})]), 1), 'Pietto returned an invalid SQL emission item.');
  assert.equal(failed(batch('VERIFIED', [{owner: {kind: 'table', name: 't'}, document: verified('SELECT 1')}])), 'Pietto returned an invalid SQL emission item.');
  assert.equal(failed(batch('VERIFIED', good), 0, 'models/other.pietto'), 'Pietto project SQL preview returned a result for a different module or dialect.');
  assert.equal(failed(batch('VERIFIED', [item('table', 't', verified('SELECT 1', 'mysql'))])), 'Pietto project SQL preview returned a result for a different module or dialect.');
  assert.equal(failed(batch('BLOCKED', good, failure('BLOCKED', {})), 1), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('VERIFIED', [], verified('SELECT 1')), 0), 'Pietto returned an unsupported project emit-sql JSON response.');
  // The status must be the one its failure document, or else its items, give.
  const blockedItem = item('query', 'q', failure('BLOCKED', {blockers: [blocker]}));
  const rejectedItem = item('query', 'r', failure('INPUT_REJECTED', {}));
  assert.equal(parseProjectPreview(batch('BLOCKED', [...good, blockedItem]), 1, 'models/main.pietto', 'postgres').status, 'ready');
  assert.equal(failed(batch('VERIFIED', [blockedItem]), 0), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('BLOCKED', good), 1), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('BLOCKED', [blockedItem, rejectedItem]), 1), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('VERIFIED', [], failure('BLOCKED', {})), 0), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('INPUT_REJECTED', [], failure('BLOCKED', {})), 2), 'Pietto returned an unsupported project emit-sql JSON response.');
  assert.equal(failed(batch('BLOCKED', [], failure('INPUT_REJECTED', {})), 1), 'Pietto returned an unsupported project emit-sql JSON response.');
});

test('the real pietto emit-sql previews a MySQL file and the modules of a two-dialect project', async () => {
  const token = {onCancellationRequested: () => ({dispose: () => undefined})};
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-preview-'));
  try {
    const project = path.join(directory, "it's a project");
    const write = (name: string, text: string) => {
      mkdirSync(path.dirname(path.join(project, name)), {recursive: true});
      writeFileSync(path.join(project, name), text);
    };
    const field = (ordinal: number, name: string, column: string, storage: unknown, domain: unknown) =>
      ({ordinal, name, column, representation: {storage, nullable: false, domain}});
    const premises = [{key: 'row_domain_matches', scope: 'source', value: true}, {key: 'read_only_object', scope: 'source', value: true}];
    write('pietto.toml', 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n');
    write('models/pg.pietto', 'shape Item:\n    id: Int\n    label: Text\n\nsource items: Item = postgres.table("fixture.items")\n\n'
      + 'table active_items:\n    from items\n    select:\n        id\n        label\n\nquery small_items:\n    from items\n    where id < 10\n    select:\n        id\n');
    write('models/my things.pietto', 'shape Thing:\n    id: Int\n    label: Text\n\nsource things: Thing = mysql.table("fixture.things")\n\n'
      + 'table all_things:\n    from things\n    select:\n        id\n        label\n');
    write('contracts/pg.json', JSON.stringify({format: 'pietto.emission-contract.v1', target: {family: 'postgres', release: '18.6'},
      sources: [{selector: {module: 'models/pg.pietto', kind: 'source', name: 'items'}, relation: {namespace: 'fixture', name: 'items'}, scan: 'relation_rows', premises, fields: [
        field(0, 'id', 'item_id', {kind: 'pg_int8'}, {kind: 'int_range', min: '0', max: '100'}),
        field(1, 'label', 'item_label', {kind: 'pg_text'}, {kind: 'text', max_characters: 64, encoding: 'UTF8', collation: 'C', padding: 'NO PAD'})]}],
      environment: [{key: 'client_encoding', scope: 'statement', value: 'UTF8'}, {key: 'operator_environment', scope: 'statement', value: 'builtin_only'}]}));
    write('contracts/my.json', JSON.stringify({format: 'pietto.emission-contract.v1', target: {family: 'mysql', release: '8.4.12'},
      sources: [{selector: {module: 'models/my things.pietto', kind: 'source', name: 'things'}, relation: {namespace: 'fixture', name: 'things'}, scan: 'relation_rows', premises, fields: [
        field(0, 'id', 'thing_id', {kind: 'my_bigint'}, {kind: 'int_range', min: '0', max: '100'}),
        field(1, 'label', 'thing_label', {kind: 'my_varchar', length: 64}, {kind: 'text', max_characters: 64, encoding: 'utf8mb4', collation: 'utf8mb4_0900_bin', padding: 'NO PAD'})]}],
      environment: [{key: 'client_encoding', scope: 'statement', value: 'utf8mb4'}, {key: 'operator_environment', scope: 'statement', value: 'builtin_only'},
        {key: 'identifier_case', scope: 'statement', value: 'lower_case_table_names=0'}]}));
    const single = path.join(directory, 'single.pietto');
    writeFileSync(single, 'shape Item:\n    id: Int\n\nsource items: Item = mysql.table("fixture.items")\n\nquery item_ids:\n    from items\n    select:\n        id\n');

    assert.deepEqual(await previewSql(python(), pythonArguments(), single, 'mysql', token), {status: 'ready', artifacts: [{kind: 'relation', name: 'item_ids', sql: 'SELECT\n    `id` AS `id`\nFROM `fixture`.`items`'}]});
    const refused = await previewSql(python(), pythonArguments(), single, 'postgres', token);
    assert.equal(refused.status, 'refused');
    assert.match(refused.status === 'refused' ? refused.message : '', /^PIE-B1000: PostgreSQL SQL emission is not implemented/);

    const request = {root: project, module: 'models/pg.pietto', dialect: 'postgres', contract: 'contracts/pg.json'} as const;
    const postgres = await previewProjectSql(python(), pythonArguments(), request, token);
    assert.equal(postgres.status, 'ready');
    const items = postgres.status === 'ready' ? postgres.items : [];
    assert.deepEqual(items.map(entry => [entry.kind, entry.name, entry.status]), [['table', 'active_items', 'VERIFIED'], ['query', 'small_items', 'BLOCKED']]);
    assert.equal(items[0].text, 'SELECT "s0"."item_id" AS "id", "s0"."item_label" AS "label" FROM "fixture"."items" AS "s0"');
    assert.match(items[1].text, /^query small_items in models\/pg\.pietto, PostgreSQL\npietto\.sql-emission\.v1 BLOCKED\nblocker PIE-B1004 MISSING_EVIDENCE: identifier_case_declaration_missing\n {2}hint: /);
    // Below its heading line, each report is what `--format=text` writes to stderr.
    const stderr = (asked: ProjectRequest) => new Promise<string>(resolve => execFile(python(),
      projectPreviewArguments(pythonArguments(), asked).map(arg => arg === '--format=json' ? '--format=text' : arg), {encoding: 'utf8'}, (_error, _stdout, written) => resolve(written)));
    const bodies = (result: ProjectPreviewResult) => (result.status === 'blocked' ? [result.report] : result.status === 'ready' ? result.items.filter(entry => entry.status !== 'VERIFIED').map(entry => entry.text) : [])
      .map(report => report.slice(report.indexOf('\n') + 1)).join('');
    assert.equal(bodies(postgres), await stderr(request));
    assert.deepEqual(await previewProjectSql(python(), pythonArguments(), {root: project, module: 'models/my things.pietto', dialect: 'mysql', contract: 'contracts/my.json'}, token),
      {status: 'ready', items: [{kind: 'table', name: 'all_things', status: 'VERIFIED', text: 'SELECT `s0`.`thing_id` AS `id`, `s0`.`thing_label` AS `label` FROM `fixture`.`things` AS `s0`'}]});
    const conflict = await previewProjectSql(python(), pythonArguments(), {...request, dialect: 'mysql'}, token);
    assert.deepEqual(conflict.status === 'ready' && conflict.items.map(entry => entry.status), ['INPUT_REJECTED', 'INPUT_REJECTED']);
    assert.equal(bodies(conflict), await stderr({...request, dialect: 'mysql'}));
    const missing = {...request, contract: 'contracts/none.json'};
    assert.deepEqual(await previewProjectSql(python(), pythonArguments(), missing, token),
      {status: 'refused', message: 'error emission_contract_read: Emission contract file could not be opened inside the project root. (path: contracts/none.json)'});
    assert.equal(await stderr(missing), 'pietto.sql-emission.v1 INPUT_REJECTED\nerror emission_contract_read: Emission contract file could not be opened inside the project root. (path: contracts/none.json)\n');
    assert.deepEqual(await previewProjectSql(python(), pythonArguments(), {...request, module: 'models/none.pietto'}, token),
      {status: 'refused', message: 'error emission_selector: No public project owner matches the supplied selectors.'});
    // A file name with a C1 control and a bidi override stays escaped on its one report line.
    write('models/bro\u0085ken\u202e.pietto', 'shape Other:\n    id: Int\n\nsource others: Other = postgres.table("fixture.others")\n\nquery broken:\n    from others\n    select:\n        emial\n');
    const broken = await previewProjectSql(python(), pythonArguments(), request, token);
    assert.deepEqual(broken, {status: 'blocked', report:
      'models/pg.pietto, PostgreSQL\npietto.sql-emission.v1 BLOCKED\nmodels/bro\\u0085ken\\u202e.pietto:9:9 PIE-S2102 error: Unknown field: emial\n'});
    assert.equal(bodies(broken), await stderr(request));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
