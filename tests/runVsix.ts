import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {resolveCliArgsFromVSCodeExecutablePath} from '@vscode/test-electron';

const root = path.resolve(__dirname, '..', '..');
const executable = process.env.VSCODE_EXECUTABLE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const userData = path.join(root, '.vscode-test', 'vsix-user-data');
const extensions = path.join(root, '.vscode-test', 'vsix-extensions');
const artifact = path.join(root, 'artifacts', 'pietto-0.1.0.vsix');
mkdirSync(extensions, {recursive: true});
mkdirSync(userData, {recursive: true});
let [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, {reuseMachineInstall: true});
if (process.platform === 'win32') {
  // Invoke the installed CLI's own bootstrap without passing a .cmd through a shell.
  const relativeBootstrap = /"%~dp0\.\.\\([^"\r\n]+cli\.js)"/i.exec(readFileSync(cli, 'utf8'))?.[1];
  if (!relativeBootstrap) throw new Error('Cannot identify the installed VS Code CLI bootstrap.');
  args = [path.resolve(path.dirname(cli), '..', relativeBootstrap), ...args];
  cli = executable;
}
const installed = spawnSync(cli, [...args, '--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', artifact, '--force'], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: ''}, windowsHide: true, shell: false, encoding: 'utf8'});
writeFileSync(path.join(root, 'artifacts', 'vsix-install.log'), `${installed.stdout ?? ''}${installed.stderr ?? ''}`);
if (installed.status !== 0) throw new Error(`Isolated VSIX installation failed: exit ${installed.status}. See artifacts/vsix-install.log.`);
const directory = readdirSync(extensions).find(name => name.toLowerCase() === 'mianliwang.pietto-vscode-extension-0.1.0');
if (!directory) throw new Error('Installed VSIX extension directory was not found.');
const extensionPath = path.join(extensions, directory);
const manifest = JSON.parse(readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
if (manifest.version !== '0.1.0' || manifest.name !== 'pietto-vscode-extension') throw new Error('Installed package identity does not match.');
const smoke = spawnSync(process.execPath, [path.join(root, 'out', 'tests', 'runHost.js')], {env: {...process.env, PIETTO_HOST_INSTALLED: '1', PIETTO_HOST_INSTALLED_PATH: extensionPath, PIETTO_HOST_USER_DATA: userData, PIETTO_HOST_EXTENSIONS: extensions}, stdio: 'inherit', windowsHide: true, shell: false});
process.exitCode = smoke.status ?? 1;
