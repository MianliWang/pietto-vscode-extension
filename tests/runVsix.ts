import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {resolveCliArgsFromVSCodeExecutablePath} from '@vscode/test-electron';
import {editor, root} from './editor';

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {name: string; publisher: string; version: string};
  const executable = await editor();
  const userData = path.join(root, '.vscode-test', 'vsix-user-data');
  const extensions = path.join(root, '.vscode-test', 'vsix-extensions');
  // vsce writes <name>-<version>.vsix into the existing artifacts folder.
  const artifact = path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.vsix`);
  rmSync(extensions, {recursive: true, force: true});
  for (const directory of [extensions, userData]) mkdirSync(directory, {recursive: true});
  let [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, {reuseMachineInstall: true});
  if (process.platform === 'win32') {
    // Invoke the installed CLI's own bootstrap without passing a .cmd through a shell.
    const relativeBootstrap = /"%~dp0\.\.\\([^"\r\n]+cli\.js)"/i.exec(readFileSync(cli, 'utf8'))?.[1];
    if (!relativeBootstrap) throw new Error('Cannot identify the installed VS Code CLI bootstrap.');
    args = [path.resolve(path.dirname(cli), '..', relativeBootstrap), ...args];
    cli = executable;
  }
  const installed = spawnSync(cli, [...args, '--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', artifact, '--force'],
    // The Linux CLI script asks for confirmation under WSL unless DONT_PROMPT_WSL_INSTALL is set.
    {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', DONT_PROMPT_WSL_INSTALL: '1'}, windowsHide: true, shell: false, encoding: 'utf8'});
  writeFileSync(path.join(root, 'artifacts', 'vsix-install.log'), `${installed.stdout ?? ''}${installed.stderr ?? ''}`);
  if (installed.status !== 0) throw new Error(`Isolated VSIX installation failed: exit ${installed.status}. See artifacts/vsix-install.log.`);
  const identity = `${manifest.publisher}.${manifest.name}-${manifest.version}`.toLowerCase();
  const directory = readdirSync(extensions).find(name => name.toLowerCase() === identity);
  if (!directory) throw new Error(`Installed extension directory ${identity} was not found.`);
  const extensionPath = path.join(extensions, directory);
  const smoke = spawnSync(process.execPath, [path.join(root, 'out', 'tests', 'runHost.js')], {stdio: 'inherit', windowsHide: true, shell: false,
    env: {...process.env, PIETTO_HOST_INSTALLED: '1', PIETTO_HOST_INSTALLED_PATH: extensionPath, PIETTO_HOST_USER_DATA: userData, PIETTO_HOST_EXTENSIONS: extensions}});
  process.exitCode = smoke.status ?? 1;
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
