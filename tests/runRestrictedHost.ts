import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const workspace = path.join(root, '.local', 'restricted-workspace');
  const profile = path.join(root, '.vscode-test', 'restricted-user-data');
  const extensions = path.join(root, '.vscode-test', 'restricted-extensions');
  const executable = process.env.VSCODE_EXECUTABLE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (!existsSync(executable)) throw new Error('Set VSCODE_EXECUTABLE to a desktop VS Code executable.');
  for (const directory of [path.join(workspace, '.vscode'), path.join(profile, 'User'), extensions]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'security.workspace.trust.untrustedFiles': 'open',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'files.hotExit': 'off',
  }, null, 2));
  writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'pietto.pythonPath': path.join(workspace, 'workspace-selected-python.exe') }, null, 2));
  writeFileSync(path.join(workspace, 'restricted.pietto'), 'shape User:\n    id: Int not null\n');
  // The normal test-electron launcher disables trust. This supported editor CLI
  // launch keeps trust enabled so the actual Restricted Mode can be observed.
  const args = [workspace, '--extensionDevelopmentPath=' + root,
    '--extensionTestsPath=' + path.join(root, 'out', 'tests', 'host', 'restricted.js'),
    '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
    '--disable-extensions', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes'];
  const environment: NodeJS.ProcessEnv = { ...process.env, PIETTO_HOST_ROOT: root, PIETTO_RESTRICTED_WORKSPACE: workspace };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'inherit', timeout: 45000,
      env: environment });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Restricted Mode editor host exited with ${code ?? signal}.`)));
  });
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
