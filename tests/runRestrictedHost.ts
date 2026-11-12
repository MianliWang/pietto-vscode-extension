import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {editor, python, quietEditor, root} from './editor';

async function main() {
  const executable = await editor();
  const workspace = path.join(root, '.local', 'restricted-workspace');
  const profile = path.join(root, '.vscode-test', 'restricted-user-data');
  const extensions = path.join(root, '.vscode-test', 'restricted-extensions');
  for (const directory of [workspace, profile]) rmSync(directory, {recursive: true, force: true});
  for (const directory of [path.join(workspace, '.vscode'), path.join(profile, 'User'), extensions]) mkdirSync(directory, {recursive: true});
  // The user interpreter is the real one, so a broken trust gate would start a working server.
  writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'security.workspace.trust.untrustedFiles': 'open',
    'pietto.pythonPath': python(),
    ...quietEditor,
  }, null, 2));
  // Target diagnostics are on, so a broken trust gate would report the missing contract.
  writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({'pietto.pythonPath': path.join(workspace, 'workspace-selected-python'), 'pietto.projectRoots': ['.'],
    'pietto.targetDiagnostics': true, 'pietto.emissionContract': 'missing.json'}, null, 2));
  writeFileSync(path.join(workspace, 'pietto.toml'), 'schema_version = 2\n\n[sources]\ninclude = ["*.pietto"]\n');
  writeFileSync(path.join(workspace, 'restricted.pietto'), 'shape User:\n    id: Int\n\nquery q:\n    from nowhere\n    select:\n        id\n\n');
  // test-electron's runTests always disables Workspace Trust. This direct launch keeps
  // trust enabled, so the real Restricted Mode is observed.
  const args = [workspace, `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'out', 'tests', 'host', 'restricted.js')}`,
    `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, '--disable-extensions', '--disable-gpu', '--no-sandbox',
    '--disable-updates', '--skip-welcome', '--skip-release-notes'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {stdio: 'inherit', timeout: 120_000, windowsHide: true,
      env: {...process.env, PIETTO_HOST_ROOT: root, PIETTO_RESTRICTED_WORKSPACE: workspace}});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Restricted Mode editor host exited with ${code ?? signal}.`)));
  });
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
