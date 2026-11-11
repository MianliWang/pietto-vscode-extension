import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {runTests} from '@vscode/test-electron';
import {editor, python, pythonArguments, quietEditor, root} from './editor';

// The emission contract of the emit project: the README example's PostgreSQL contract for
// the source items of models/items.pietto.
const contract = {
  format: 'pietto.emission-contract.v1',
  target: {family: 'postgres', release: '18.6'},
  sources: [{
    selector: {module: 'models/items.pietto', kind: 'source', name: 'items'},
    relation: {namespace: 'fixture', name: 'items'},
    scan: 'relation_rows',
    fields: [
      {ordinal: 0, name: 'id', column: 'item_id', representation: {storage: {kind: 'pg_int8'}, nullable: false, domain: {kind: 'int_range', min: '0', max: '100'}}},
      {ordinal: 1, name: 'label', column: 'item_label', representation: {storage: {kind: 'pg_text'}, nullable: false,
        domain: {kind: 'text', max_characters: 64, encoding: 'UTF8', collation: 'C', padding: 'NO PAD'}}},
    ],
    premises: [{key: 'row_domain_matches', scope: 'source', value: true}, {key: 'read_only_object', scope: 'source', value: true}],
  }],
  environment: [{key: 'client_encoding', scope: 'statement', value: 'UTF8'}, {key: 'operator_environment', scope: 'statement', value: 'builtin_only'}],
};

// The acceptance workspace: an EXPLICIT_MODULES project, a second
// configuration that also selects them, files outside the project, and an
// emit project with an emission contract for project SQL preview.
const fixture: Record<string, string> = {
  '.vscode/settings.json': '{}\n',
  'project/pietto.toml': 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n',
  'project/models/pietto.toml': 'schema_version = 2\n\n[sources]\ninclude = ["*.pietto"]\n',
  'project/models/users.pietto': 'shape User:\n    id: Int\n    email: Text | None\n\nsource users: User = postgres.table("public.users")\n\nexport (\n    shape User,\n    source users)\n',
  'project/models/report.pietto': 'from "models/users.pietto" import (\n    source users)\n\nquery emails:\n    from users\n    select:\n        id\n        emial\n',
  'project/models/facts.pietto': 'from "models/users.pietto" import (\n    shape User,\n    source users)\n\nshape Audit:\n    owner: User\n\nquery audit_users:\n    from users\n    select:\n        id\n',
  'loose/outside.pietto': 'from "models/users.pietto" import (\n    source users)\n\nquery emails:\n    from users\n    select:\n        id\n',
  'loose/preview.pietto': 'shape Item:\n    id: Int\n\nsource items: Item = postgres.table("public.items")\n\nquery item_ids:\n    from items\n    select:\n        id\n',
  'loose/legacy.pietto': 'shape User:\n    id: Int not null\n    email: Text nullable\n\nsource users: User = postgres.table("public.users")\n',
  'loose/manual.pietto': 'mode strict\nshape Legacy:\n    id: Int\n',
  'loose/preview-mysql.pietto': 'shape Item:\n    id: Int\n\nsource items: Item = mysql.table("fixture.items")\n\nquery item_ids:\n    from items\n    select:\n        id\n',
  'emit/pietto.toml': 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n',
  'emit/contract.json': `${JSON.stringify(contract, null, 2)}\n`,
  'emit/models/items.pietto': 'shape Item:\n    id: Int\n    label: Text\n\nsource items: Item = postgres.table("fixture.items")\n\ntable active_items:\n    from items\n    select:\n        id\n        label\n\n'
    + 'query small_items:\n    from items\n    where id < 10\n    select:\n        id\n\nexport (\n    source items)\n',
  'emit/models/blocked.pietto': 'from "models/items.pietto" import (\n    source items)\n\nquery large_items:\n    from items\n    where id > 90\n    select:\n        id\n',
};

async function main() {
  const executable = await editor();
  const installed = process.env.PIETTO_HOST_INSTALLED === '1';
  const workspace = process.env.PIETTO_HOST_WORKSPACE ?? path.join(root, '.local', 'host-workspace');
  const profile = process.env.PIETTO_HOST_USER_DATA ?? path.join(root, '.vscode-test', 'host-user-data');
  const extensions = process.env.PIETTO_HOST_EXTENSIONS ?? path.join(root, '.vscode-test', 'host-extensions');
  const driver = path.join(root, '.local', 'vsix-test-driver');
  for (const directory of [workspace, profile]) rmSync(directory, {recursive: true, force: true});
  for (const [name, text] of Object.entries(fixture)) {
    mkdirSync(path.dirname(path.join(workspace, name)), {recursive: true});
    writeFileSync(path.join(workspace, name), text);
  }
  for (const directory of [path.join(profile, 'User'), extensions, path.join(root, '.local'), path.join(root, 'artifacts')]) mkdirSync(directory, {recursive: true});
  writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({'pietto.pythonPath': python(), 'pietto.pythonArguments': pythonArguments(), ...quietEditor}, null, 2));
  if (installed) {
    // The installed extension is not a development extension, so an empty one carries the tests.
    mkdirSync(driver, {recursive: true});
    writeFileSync(path.join(driver, 'package.json'), JSON.stringify({name: 'pietto-vsix-test-driver', publisher: 'local-pietto-tests', version: '0.0.0', private: true, engines: {vscode: '^1.90.0'}, main: './extension.js'}, null, 2));
    writeFileSync(path.join(driver, 'extension.js'), 'exports.activate = function () {};\n');
  }
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: installed ? driver : root,
    extensionTestsPath: path.join(root, 'out', 'tests', 'host', 'index.js'),
    launchArgs: [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, '--disable-gpu', ...(installed ? [] : ['--disable-extensions'])],
    extensionTestsEnv: {PIETTO_HOST_ROOT: root, PIETTO_HOST_WORKSPACE: workspace, PIETTO_HOST_INSTALLED_PATH: installed ? process.env.PIETTO_HOST_INSTALLED_PATH : undefined,
      PIETTO_TEST_OLD_PYTHON: process.env.PIETTO_TEST_OLD_PYTHON},
  });
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
