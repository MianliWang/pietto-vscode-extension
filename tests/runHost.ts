import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {runTests} from '@vscode/test-electron';
import {editor, python, pythonArguments, quietEditor, root} from './editor';

// The acceptance workspace: an EXPLICIT_MODULES project of two modules, a second
// configuration that also selects them, and a file outside the project.
const fixture: Record<string, string> = {
  '.vscode/settings.json': '{}\n',
  'project/pietto.toml': 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n',
  'project/models/pietto.toml': 'schema_version = 2\n\n[sources]\ninclude = ["*.pietto"]\n',
  'project/models/users.pietto': 'shape User:\n    id: Int\n    email: Text | None\n\nsource users: User = postgres.table("public.users")\n\nexport (\n    shape User,\n    source users)\n',
  'project/models/report.pietto': 'from "models/users.pietto" import (\n    source users)\n\nquery emails:\n    from users\n    select:\n        id\n        emial\n',
  'loose/outside.pietto': 'from "models/users.pietto" import (\n    source users)\n\nquery emails:\n    from users\n    select:\n        id\n',
};

async function main() {
  const executable = await editor();
  const installed = process.env.PIETTO_HOST_INSTALLED === '1';
  const workspace = path.join(root, '.local', 'host-workspace');
  const profile = process.env.PIETTO_HOST_USER_DATA ?? path.join(root, '.vscode-test', 'host-user-data');
  const extensions = process.env.PIETTO_HOST_EXTENSIONS ?? path.join(root, '.vscode-test', 'host-extensions');
  const driver = path.join(root, '.local', 'vsix-test-driver');
  for (const directory of [workspace, profile]) rmSync(directory, {recursive: true, force: true});
  for (const [name, text] of Object.entries(fixture)) {
    mkdirSync(path.dirname(path.join(workspace, name)), {recursive: true});
    writeFileSync(path.join(workspace, name), text);
  }
  for (const directory of [path.join(profile, 'User'), extensions, path.join(root, 'artifacts')]) mkdirSync(directory, {recursive: true});
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
