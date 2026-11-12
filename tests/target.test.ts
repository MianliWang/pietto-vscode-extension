import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileTargets, parseFileTargets, parseProjectTargets, projectTargets, range, sourceLines, TargetResult} from '../src/target';
import {ProjectTarget} from '../src/launch';
import {python, pythonArguments} from './editor';

const token = {onCancellationRequested: () => ({dispose() {}})};
const problems = (result: TargetResult) => {
  assert.equal(result.status, 'ready', JSON.stringify(result));
  return result.status === 'ready' ? result.problems : [];
};
const failed = (result: TargetResult) => result.status === 'failed' ? result.message : `not failed: ${JSON.stringify(result)}`;

test('a Pietto location becomes the UTF-16 range that pietto lsp gives it', () => {
  // The emoji is one character to Pietto and two UTF-16 units to VS Code; a BOM is not counted.
  const lines = sourceLines('\uFEFFshape S:\r\n    \u{1F600}a: Int\rquery q:\n    x');
  assert.deepEqual(lines, ['shape S:', '    \u{1F600}a: Int', 'query q:', '    x']);
  const at = (line: number, column: number, endLine: number | null = null, endColumn: number | null = null) => range(lines, {line, column, endLine, endColumn});
  assert.deepEqual(at(2, 6, 2, 7), [1, 6, 1, 7]);
  assert.deepEqual(at(2, 5, 3, 9), [1, 4, 2, 8]);
  assert.deepEqual(at(1, 1), [0, 0, 0, 0], 'A missing end is the start.');
  assert.deepEqual(at(3, 2, 3, null), [2, 1, 2, 1]);
  assert.deepEqual(at(1, 40), [0, 8, 0, 8], 'A column past the line end is its end.');
  assert.deepEqual(at(9, 1), [3, 5, 3, 5], 'A line past the end is the end of the last line.');
  assert.deepEqual(range(lines, null), [0, 0, 0, 0]);
  assert.deepEqual(sourceLines(''), ['']);
});

const source = '/work/one.pietto';
const at = (line: number, column: number, end_line: number | null = null, end_column: number | null = null, file: string | null = source) => ({path: file, line, column, end_line, end_column});
const envelope = (fields: Record<string, unknown>) => JSON.stringify({schema_version: 1, command: 'emit-sql', ok: false, path: source, dialect: 'postgres', output: null, diagnostics: [], cli_errors: [], artifacts: [], ...fields});
const refusal = {code: 'PIE-B1000', severity: 'error', message: 'PostgreSQL SQL emission is not implemented', location: at(6, 1, 10, 22), suggestion: 'use mysql'};
const truncates = {code: 'PIE-S2106', severity: 'warning', message: '`/` of two Int values truncates in SQL', location: at(10, 16, 10, 22), suggestion: null};

test('single file: each PIE-B refusal as emit-sql reports it; a warning does not hide them, an error that is not PIE-B does', () => {
  const unlocated = {...refusal, code: 'PIE-B1003', location: null, suggestion: 'emission is not'};
  assert.deepEqual(problems(parseFileTargets(envelope({diagnostics: [truncates, refusal, unlocated, {...refusal, location: at(2, 3, null, null, null)}]}), 1, 'postgres', source)), [
    {path: null, location: {line: 6, column: 1, endLine: 10, endColumn: 22}, code: 'PIE-B1000', related: [], message: 'PostgreSQL SQL emission is not implemented\nuse mysql'},
    // A suggestion that the message already holds is not repeated.
    {path: null, location: null, code: 'PIE-B1003', related: [], message: 'PostgreSQL SQL emission is not implemented'},
    {path: null, location: {line: 2, column: 3, endLine: null, endColumn: null}, code: 'PIE-B1000', related: [], message: 'PostgreSQL SQL emission is not implemented\nuse mysql'},
  ]);
  for (const code of ['PIE-S2102', 'PIE-P1000', 'PIE-I1000']) {
    assert.deepEqual(problems(parseFileTargets(envelope({diagnostics: [refusal, {...truncates, code, severity: 'error'}]}), 1, 'postgres', source)), [], code);
  }
  assert.deepEqual(problems(parseFileTargets(envelope({ok: true, diagnostics: [truncates], artifacts: [{kind: 'relation', name: 'q', sql: 'SELECT 1'}]}), 0, 'postgres', source)), []);
  assert.deepEqual(problems(parseFileTargets(envelope({dialect: 'mysql', cli_errors: [{kind: 'file_read', message: 'No such file or directory (errno 2)', path: source}]}), 2, 'mysql', source)),
    [{path: null, location: null, related: [], message: `file_read: No such file or directory (errno 2) (path: ${source})`}]);
  // A later Pietto may add fields.
  assert.deepEqual(problems(parseFileTargets(envelope({added: 1, diagnostics: [{...refusal, added: 1, location: {...refusal.location, added: 1}}]}), 1, 'postgres', source)).map(item => item.code), ['PIE-B1000']);
});

test('single file: an output it cannot read gives one failure and no partial result', () => {
  const parse = (fields: Record<string, unknown>, exit: number | null = 1) => failed(parseFileTargets(envelope(fields), exit, 'postgres', source));
  const unsupported = 'Pietto returned an unsupported emit-sql JSON response.';
  assert.equal(failed(parseFileTargets('{', 1, 'postgres', source)), 'Pietto did not return valid JSON for PostgreSQL target diagnostics.');
  assert.equal(parse({diagnostics: [refusal]}, 0), 'Pietto stopped before PostgreSQL target diagnostics completed.');
  assert.equal(parse({diagnostics: [refusal]}, null), 'Pietto stopped before PostgreSQL target diagnostics completed.');
  assert.equal(parse({ok: true, diagnostics: [refusal]}, 1), unsupported);
  assert.equal(parse({path: '/work/other.pietto', diagnostics: [refusal]}), unsupported);
  assert.equal(parse({dialect: 'mysql', diagnostics: [refusal]}), unsupported);
  assert.equal(parse({diagnostics: [{...refusal, location: at(6, 1, 10, 22, '/work/other.pietto')}]}), unsupported);
  for (const location of [at(0, 1), at(1, 0), at(1, 1.5), at(1, 1, 0, 1), {line: 1, column: 1}, 'one.pietto:1:1']) {
    assert.equal(parse({diagnostics: [{...refusal, location}]}), unsupported, JSON.stringify(location));
  }
  assert.equal(parse({diagnostics: [{...refusal, severity: 'fatal'}]}), unsupported);
  assert.equal(parse({diagnostics: [{...refusal, suggestion: 3}]}), unsupported);
  assert.equal(parse({diagnostics: [{...truncates, code: 'PIE-S2102', severity: 'error'}, {...refusal, code: null}]}), unsupported, 'Every entry is read before any is left out.');
  assert.equal(parse({cli_errors: [{kind: 'usage', message: 'missing'}]}, 2), unsupported);
});

const owner = (kind: string, name: string, module = 'models/main.pietto') => ({kind, module, name});
const verified = (family = 'postgres', fields: Record<string, unknown> = {}) => ({format: 'pietto.sql-emission.v1', status: 'VERIFIED', sql: 'SELECT 1', target: {family, release: '18.6'}, diagnostics: [], ...fields});
const failure = (status: string, fields: Record<string, unknown>) => ({format: 'pietto.sql-emission.v1', status, artifact: null, blockers: [], cli_errors: [], diagnostics: [], ...fields});
const evidence = {code: 'PIE-B1004', location: null, reason: 'MISSING_EVIDENCE', related: [], subject: {detail: 'identifier_case_declaration_missing', reference: {kind: 'selected_plan', position: 0}},
  suggestion: 'add {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"'};
const rule = {code: 'PIE-B1003', location: at(9, 9, 9, 17, 'models/main.pietto'), reason: 'UNSUPPORTED_RULE', subject: {detail: 'expression_evidence_unavailable'}, suggestion: 'resolve it',
  related: [at(1, 2, null, null, 'models/other.pietto'), at(1, 1, 1, 1, null)]};
const untyped = {code: 'PIE-S2385', severity: 'warning', message: 'untyped all-None output', location: at(9, 13, 9, 17, 'models/main.pietto'), suggestion: null};
const unknownField = {code: 'PIE-S2102', severity: 'error', message: 'Unknown field: emial', location: at(7, 9, 7, 14, 'models/main.pietto'), suggestion: null};
const batch = (status: string, items: unknown[], failed: unknown = null) => JSON.stringify({format: 'pietto.sql-emission.batch.v1', status, items, failure: failed, added: []});
const item = (who: ReturnType<typeof owner>, document: unknown) => ({owner: who, path: 'artifacts/000000.json', document});
const parse = (stdout: string, exit: number | null) => parseProjectTargets(stdout, exit, 'postgres', 'contracts/pg.json');

test('project: the PIE-B blockers and CLI errors of each item that is not VERIFIED, in batch order, at its location or else its module', () => {
  assert.deepEqual(problems(parse(batch('INPUT_REJECTED', [
    item(owner('table', 'all_items'), verified('postgres', {diagnostics: [untyped]})),
    // A blocker without a location goes to the owner's module; a non-PIE-B blocker and a warning are left out.
    item(owner('query', 'small_items'), failure('BLOCKED', {blockers: [evidence, {...rule, code: 'PIE-I1000'}, rule], diagnostics: [untyped]})),
    item(owner('table', 'odd', 'models/other.pietto'), failure('INPUT_REJECTED', {cli_errors: [{kind: 'emission_contract_schema', message: 'Emission contract target family conflicts with --dialect.', path: 'target/family'}]})),
    item(owner('query', 'broken'), failure('BLOCKED', {blockers: [evidence], diagnostics: [unknownField]})),
    item(owner('query', 'big_items'), failure('BLOCKED', {blockers: [evidence]})),
  ]), 2)), [
    {path: 'models/main.pietto', location: null, code: 'PIE-B1004', related: [],
      message: 'query small_items: MISSING_EVIDENCE: identifier_case_declaration_missing\nadd {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"'},
    {path: 'models/main.pietto', location: {line: 9, column: 9, endLine: 9, endColumn: 17}, code: 'PIE-B1003',
      related: [{path: 'models/other.pietto', location: {line: 1, column: 2, endLine: null, endColumn: null}}], message: 'query small_items: UNSUPPORTED_RULE: expression_evidence_unavailable\nresolve it'},
    {path: 'models/other.pietto', location: null, related: [], message: 'table odd: emission_contract_schema: Emission contract target family conflicts with --dialect. (path: target/family)'},
    {path: 'models/main.pietto', location: null, code: 'PIE-B1004', related: [],
      message: 'query big_items: MISSING_EVIDENCE: identifier_case_declaration_missing\nadd {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"'},
  ]);
  assert.deepEqual(problems(parse(batch('VERIFIED', [item(owner('table', 't'), verified())]), 0)), []);
  // Names are escaped as the SQL preview report escapes them.
  assert.deepEqual(problems(parse(batch('BLOCKED', [item(owner('query', 'q\n\u202e'), failure('BLOCKED', {blockers: [{...evidence, reason: 'A\tB'}]}))]), 1)).map(found => found.message.split('\n')[0]),
    ['query q\\x0a\\u202e: A\\x09B: identifier_case_declaration_missing']);
});

test('project: a whole-batch failure shows nothing for a check error or a project error that pietto lsp reports, and else its own problems', () => {
  assert.deepEqual(problems(parse(batch('BLOCKED', [], failure('BLOCKED', {diagnostics: [untyped, unknownField], blockers: [evidence]})), 1)), []);
  assert.deepEqual(problems(parse(batch('BLOCKED', [], failure('BLOCKED', {diagnostics: [untyped], blockers: [evidence, rule]})), 1)), [
    {path: null, location: null, code: 'PIE-B1004', related: [], message: 'MISSING_EVIDENCE: identifier_case_declaration_missing\nadd {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"'},
    {path: 'models/main.pietto', location: {line: 9, column: 9, endLine: 9, endColumn: 17}, code: 'PIE-B1003',
      related: [{path: 'models/other.pietto', location: {line: 1, column: 2, endLine: null, endColumn: null}}], message: 'UNSUPPORTED_RULE: expression_evidence_unavailable\nresolve it'},
  ]);
  const rejected = (cli_errors: unknown[]) => problems(parse(batch('INPUT_REJECTED', [], failure('INPUT_REJECTED', {cli_errors})), 2));
  for (const kind of ['project_root', 'config_read', 'config_parse', 'config_schema', 'project_path', 'project_glob', 'project_resource', 'source_read']) {
    assert.deepEqual(rejected([{kind, message: 'reported by pietto lsp', path: 'pietto.toml'}]), [], kind);
  }
  assert.deepEqual(rejected([
    {kind: 'config_schema', message: 'reported by pietto lsp', path: 'pietto.toml'},
    {kind: 'emission_contract_read', message: 'Emission contract file could not be opened inside the project root.', path: 'contracts/pg.json'},
    {kind: 'emission_contract_schema', message: 'Emission contract target family conflicts with --dialect.', path: 'target/family'},
    {kind: 'emission_selector', message: 'No public project owner matches the supplied selectors.', path: null},
    {kind: 'batch_output_limit', message: 'too large', path: null},
  ]), [
    {path: 'contracts/pg.json', location: null, related: [], message: 'emission_contract_read: Emission contract file could not be opened inside the project root. (path: contracts/pg.json)'},
    {path: 'contracts/pg.json', location: null, related: [], message: 'emission_contract_schema: Emission contract target family conflicts with --dialect. (path: target/family)'},
    {path: null, location: null, related: [], message: 'emission_selector: No public project owner matches the supplied selectors.'},
    {path: null, location: null, related: [], message: 'batch_output_limit: too large'},
  ]);
});

test('project: an output it cannot read gives one failure and no partial result', () => {
  const unsupported = 'Pietto returned an unsupported project emit-sql JSON response.';
  const blocked = (fields: Record<string, unknown>, module = 'models/main.pietto') => batch('BLOCKED', [item(owner('query', 'q', module), failure('BLOCKED', fields))]);
  assert.equal(failed(parse('{', 1)), 'Pietto did not return valid JSON for project PostgreSQL target diagnostics.');
  assert.equal(failed(parse(blocked({blockers: [evidence]}), 0)), 'Pietto stopped before project PostgreSQL target diagnostics completed.');
  assert.equal(failed(parse(JSON.stringify({format: 'pietto.sql-emission.batch.v2', status: 'VERIFIED', items: [], failure: null}), 0)), unsupported);
  assert.equal(failed(parse(batch('VERIFIED', [item(owner('query', 'q'), failure('BLOCKED', {blockers: [evidence]}))]), 0)), unsupported, 'The status must be the one its items give.');
  assert.equal(failed(parse(batch('VERIFIED', [item(owner('table', 't'), verified('mysql'))]), 0)), unsupported, 'A VERIFIED item of another dialect.');
  for (const module of ['../models/main.pietto', '/models/main.pietto', 'models//main.pietto', 'models/./main.pietto', '']) {
    assert.equal(failed(parse(blocked({blockers: [evidence]}, module), 1)), unsupported, module);
  }
  for (const odd of [{...evidence, suggestion: null}, {...evidence, subject: 'x'}, {...evidence, related: null}, {...rule, related: [at(0, 1)]},
    {...rule, location: at(9, 9, 9, 17, '../main.pietto')}, {...evidence, code: 3}]) {
    assert.equal(failed(parse(blocked({blockers: [odd]}), 1)), unsupported, JSON.stringify(odd));
  }
  assert.equal(failed(parse(blocked({blockers: [evidence], diagnostics: [{...untyped, severity: 'notice'}]}), 1)), unsupported);
  assert.equal(failed(parse(blocked({blockers: [evidence], cli_errors: [{kind: 'usage', message: 'x', path: 3}]}), 1)), unsupported);
});

test('the real pietto emit-sql: target problems of a project root and of single files', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-target-'));
  try {
    const project = path.join(directory, "it's a project");
    const write = (name: string, text: string) => {
      mkdirSync(path.dirname(path.join(project, name)), {recursive: true});
      writeFileSync(path.join(project, name), text);
    };
    const field = (ordinal: number, name: string, column: string, storage: unknown, domain: unknown) => ({ordinal, name, column, representation: {storage, nullable: false, domain}});
    write('pietto.toml', 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n');
    write('contract.json', JSON.stringify({format: 'pietto.emission-contract.v1', target: {family: 'postgres', release: '18.6'},
      sources: [{selector: {module: 'models/items.pietto', kind: 'source', name: 'items'}, relation: {namespace: 'fixture', name: 'items'}, scan: 'relation_rows',
        premises: [{key: 'row_domain_matches', scope: 'source', value: true}, {key: 'read_only_object', scope: 'source', value: true}], fields: [
          field(0, 'id', 'item_id', {kind: 'pg_int8'}, {kind: 'int_range', min: '0', max: '100'}),
          field(1, 'label', 'item_label', {kind: 'pg_text'}, {kind: 'text', max_characters: 64, encoding: 'UTF8', collation: 'C', padding: 'NO PAD'})]}],
      environment: [{key: 'client_encoding', scope: 'statement', value: 'UTF8'}, {key: 'operator_environment', scope: 'statement', value: 'builtin_only'}]}));
    write('models/items.pietto', 'shape Item:\n    id: Int\n    label: Text\n\nsource items: Item = postgres.table("fixture.items")\n\ntable active_items:\n    from items\n    select:\n        id\n        label\n\n'
      + 'query small_items:\n    from items\n    where id < 10\n    select:\n        id\n\nexport (\n    source items)\n');
    const blocked = 'from "models/items.pietto" import (\n    source items)\n\nquery large_items:\n    from items\n    where id > 90\n    select:\n        id\n';
    write('models/blocked.pietto', blocked);
    const request: ProjectTarget = {root: project, dialect: 'postgres', contract: 'contract.json'};
    const run = (asked = request) => projectTargets(python(), pythonArguments(), asked, token);
    const evidenceAt = (module: string, name: string) => ({path: module, location: null, code: 'PIE-B1004', related: [],
      message: `query ${name}: MISSING_EVIDENCE: identifier_case_declaration_missing\nadd {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"`});
    // The table active_items is VERIFIED; both queries miss evidence, which has no location.
    assert.deepEqual(problems(await run()), [evidenceAt('models/items.pietto', 'small_items'), evidenceAt('models/blocked.pietto', 'large_items')]);
    // An untyped all-None output: a check warning (PIE-S2385), which leaves the located refusal shown.
    write('models/blocked.pietto', blocked.replace('        id\n', '        id\n        n = None\n'));
    const located = problems(await run());
    assert.deepEqual(located.map(found => [found.path, found.code, found.location]), [
      ['models/items.pietto', 'PIE-B1004', null], ['models/blocked.pietto', 'PIE-B1003', {line: 9, column: 9, endLine: 9, endColumn: 17}]]);
    assert.match(located[1].message, /^query large_items: UNSUPPORTED_RULE: expression_evidence_unavailable\n./);
    // A check error: pietto lsp shows it, and the root shows nothing.
    write('models/blocked.pietto', blocked.replace('        id\n', '        emial\n'));
    assert.deepEqual(problems(await run()), []);
    write('models/blocked.pietto', blocked);
    assert.deepEqual(problems(await run({...request, dialect: 'mysql'})), [['table', 'active_items', 'models/items.pietto'], ['query', 'small_items', 'models/items.pietto'], ['query', 'large_items', 'models/blocked.pietto']]
      .map(([kind, name, module]) => ({path: module, location: null, related: [], message: `${kind} ${name}: emission_contract_schema: Emission contract target family conflicts with --dialect. (path: target/family)`})));
    assert.deepEqual(problems(await run({...request, contract: 'none.json'})),
      [{path: 'none.json', location: null, related: [], message: 'emission_contract_read: Emission contract file could not be opened inside the project root. (path: none.json)'}]);
    write('pietto.toml', 'schema_version = 2\nbogus = 1\n\n[sources]\ninclude = ["models/*.pietto"]\n');
    assert.deepEqual(problems(await run()), [], 'pietto lsp reports the configuration error.');

    // A MySQL source compiled for PostgreSQL: the backend refusal is shown and the check warning (PIE-S2106) is not.
    const single = path.join(directory, 'single.pietto');
    writeFileSync(single, 'shape Item:\n    id: Int\n\nsource items: Item = mysql.table("fixture.items")\n\nquery item_ids:\n    from items\n    select:\n        id\n        half = id / 2\n');
    const refused = problems(await fileTargets(python(), pythonArguments(), single, 'postgres', token));
    assert.deepEqual(refused.map(found => [found.path, found.code, found.location]), [[null, 'PIE-B1000', {line: 6, column: 1, endLine: 10, endColumn: 22}]]);
    assert.match(refused[0].message, /^PostgreSQL SQL emission is not implemented/);
    assert.deepEqual(problems(await fileTargets(python(), pythonArguments(), single, 'mysql', token)), []);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
