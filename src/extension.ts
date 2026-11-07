import * as vscode from 'vscode';
import * as path from 'node:path';
import {ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import {LanguageClient} from 'vscode-languageclient/node';
import {fromWsl, isWslLauncher, probe, resolveRoots, serverArguments, strings, toWsl} from './launch';

let client: LanguageClient | undefined;
let server: ChildProcess | undefined;

async function stop(): Promise<void> {
  const [oldClient, oldServer] = [client, server];
  client = server = undefined;
  await oldClient?.dispose().catch(() => undefined); // A client that never started cannot shut down.
  oldServer?.kill();
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Pietto');
  const notices: string[] = [];
  let pythonOverride: string | undefined;
  let queue = Promise.resolve();
  const notify = (notice: string) => {
    notices.push(notice);
    output.appendLine(notice);
    void vscode.window.showErrorMessage(notice);
  };
  const start = async () => {
    await stop();
    if (!vscode.workspace.isTrusted) return;
    const config = vscode.workspace.getConfiguration('pietto');
    const python = pythonOverride ?? config.get<string>('pythonPath', 'python');
    const launcher = strings(config.get('pythonArguments'));
    const failure = await probe(python, launcher);
    if (failure !== undefined) {
      notify(`Pietto diagnostics are off: "${python}" could not run "pietto lsp" (${failure}). Install pietto 0.1.10 or later in that Python environment, or run "Pietto: Select Python Interpreter", then "Pietto: Restart Language Server".`);
      return;
    }
    const wsl = isWslLauncher(python);
    const roots = resolveRoots((vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => [folder.uri.fsPath, vscode.workspace.getConfiguration('pietto', folder.uri).get('projectRoots')]));
    client = new LanguageClient('pietto', 'Pietto', async () => {
      const child = spawn(python, serverArguments(launcher), {windowsHide: true});
      await once(child, 'spawn');
      return server = child;
    }, {
      documentSelector: [{scheme: 'file', language: 'pietto'}, {scheme: 'untitled', language: 'pietto'}],
      initializationOptions: {projectRoots: wsl ? roots.map(toWsl) : roots},
      diagnosticCollectionName: 'pietto',
      outputChannel: output,
      uriConverters: wsl ? {
        code2Protocol: uri => uri.scheme === 'file' ? vscode.Uri.file(toWsl(uri.fsPath)).toString() : uri.toString(),
        protocol2Code: value => {
          const uri = vscode.Uri.parse(value);
          const windowsPath = uri.scheme === 'file' ? fromWsl(uri.path) : undefined;
          return windowsPath ? vscode.Uri.file(windowsPath) : uri;
        },
      } : undefined,
    });
    // The client reports its own start failures. A server that never answers must not hold
    // back later restarts, which stop it.
    const answered = await Promise.race([client.start().then(() => true, () => true), new Promise<false>(resolve => setTimeout(resolve, 30_000, false))]);
    if (!answered) notify(`Pietto diagnostics are not running: "pietto lsp" from "${python}" has not answered within 30 seconds. Run "Pietto: Restart Language Server" to replace it.`);
  };
  const restart = () => (queue = queue.then(start).catch(error => output.appendLine(`Pietto language server: ${error}`)));
  context.subscriptions.push(output,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (['pythonPath', 'pythonArguments', 'projectRoots'].some(name => event.affectsConfiguration(`pietto.${name}`))) void restart();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void restart()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void restart()),
    vscode.commands.registerCommand('pietto.restart', restart),
    vscode.commands.registerCommand('pietto.selectPython', async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showInformationMessage('Trust this workspace before selecting an interpreter for Pietto diagnostics.'); return; }
      const value = await vscode.window.showInputBox({title: 'Pietto Python Interpreter', prompt: 'Python executable that has pietto 0.1.10 or later installed',
        value: pythonOverride ?? vscode.workspace.getConfiguration('pietto').get('pythonPath', 'python')});
      if (!value) return;
      if (vscode.workspace.workspaceFolders?.length) await vscode.workspace.getConfiguration('pietto').update('pythonPath', value, vscode.ConfigurationTarget.Workspace);
      else { pythonOverride = value; await restart(); }
    }),
    vscode.commands.registerCommand('pietto.selectProject', async (target?: vscode.Uri) => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      let uri = target;
      if (!uri) {
        if (!folders.length) { await vscode.window.showInformationMessage('Open the folder that holds pietto.toml first.'); return; }
        const choice = await vscode.window.showQuickPick([...folders.map(folder => ({label: folder.name, description: folder.uri.fsPath, uri: folder.uri})),
          {label: 'Choose a subfolder…', description: 'Inside an open workspace folder', uri: undefined}], {title: 'Select Explicit Pietto Project Root', placeHolder: 'The folder that holds pietto.toml'});
        if (!choice) return;
        uri = choice.uri ?? (await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: folders[0].uri}))?.[0];
        if (!uri) return;
      }
      const folder = uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
      if (!folder) { await vscode.window.showErrorMessage('Choose a project root inside an open workspace folder.'); return; }
      const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') || '.';
      await vscode.workspace.getConfiguration('pietto', folder.uri).update('projectRoots', [relative], vscode.ConfigurationTarget.WorkspaceFolder);
    }),
    vscode.commands.registerCommand('pietto.clearProject', async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const config = vscode.workspace.getConfiguration('pietto', folder.uri);
        if (config.get<string[]>('projectRoots', []).length) await config.update('projectRoots', [], vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }));
  void restart();
  return {get client() { return client; }, notices};
}

export function deactivate(): Promise<void> { return stop(); }
