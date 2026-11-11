import * as vscode from 'vscode';
import * as path from 'node:path';
import {ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import {LanguageClient} from 'vscode-languageclient/node';
import {Dialect, fromWsl, isDialect, isWslLauncher, probe, projectsOf, resolveRoots, serverArguments, strings, toWsl} from './launch';
import {dialectNames, previewProjectSql, previewSql, showIfCurrent} from './preview';

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
  let previewEpoch = 0;
  let previewRequest = 0;
  const previews = new Map<string, string>();
  // The latest project preview: a change or save of a file in its root makes its result stale.
  let projectPreview: {readonly root: string; stale: boolean} | undefined;
  const configuredRoots = () => resolveRoots((vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
    .map(folder => [folder.uri.fsPath, vscode.workspace.getConfiguration('pietto', folder.uri).get('projectRoots')]));
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
    const roots = configuredRoots();
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
  const previewProvider = vscode.workspace.registerTextDocumentContentProvider('pietto-sql-preview', {
    provideTextDocumentContent: uri => previews.get(uri.toString()),
  });
  const currentPreview = (document: vscode.TextDocument, version: number, epoch: number, request: number) =>
    previewEpoch === epoch
    && previewRequest === request
    && document.version === version
    && !document.isDirty
    && vscode.workspace.textDocuments.includes(document);
  // A read-only document; its name gives the language: .sql for SQL, .txt for a refusal report.
  const openPreview = async (name: string, text: string, current: () => boolean, request: number) => {
    const uri = vscode.Uri.from({scheme: 'pietto-sql-preview', path: `/${name}`, query: String(request)});
    previews.set(uri.toString(), text);
    if (!await showIfCurrent(
      () => vscode.workspace.openTextDocument(uri),
      current,
      preview => vscode.window.showTextDocument(preview, {preview: true}),
    )) previews.delete(uri.toString());
  };
  const interpreter = () => {
    const config = vscode.workspace.getConfiguration('pietto');
    const python = pythonOverride ?? config.get<string>('pythonPath', 'python');
    return {python, launcher: strings(config.get('pythonArguments')), wsl: isWslLauncher(python)};
  };
  // The saved, unchanged Pietto file of the active editor; otherwise the reason goes to the user.
  const savedPietto = (what: string) => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('Trust this workspace before previewing Pietto SQL.'); return undefined; }
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'pietto' || document.uri.scheme !== 'file') { void vscode.window.showInformationMessage(`Open a saved Pietto file before previewing ${what}.`); return undefined; }
    if (document.isDirty) { void vscode.window.showInformationMessage(`Save this Pietto file before previewing ${what}.`); return undefined; }
    return document;
  };
  // A command argument such as {"dialect": "mysql"} from a keybinding; anything else has no options.
  const option = (options: unknown, key: string) => typeof options === 'object' && options !== null ? (options as Record<string, unknown>)[key] : undefined;
  const dialectOf = (document: vscode.TextDocument, options: unknown): Dialect | undefined => {
    const argument = option(options, 'dialect');
    const dialect = argument ?? vscode.workspace.getConfiguration('pietto', document.uri).get('sqlDialect', 'postgres');
    if (isDialect(dialect)) return dialect;
    void vscode.window.showErrorMessage(argument === undefined ? 'Set pietto.sqlDialect to postgres or mysql.' : 'The dialect argument of a Pietto SQL preview must be "postgres" or "mysql".');
    return undefined;
  };
  const preview = async (fixed: Dialect | undefined, options: unknown) => {
    const document = savedPietto(fixed ? `${dialectNames[fixed]} SQL` : 'SQL');
    const dialect = document && (fixed ?? dialectOf(document, options));
    if (!document || !dialect) return;
    const name = dialectNames[dialect];
    const {python, launcher, wsl} = interpreter();
    const source = wsl ? toWsl(document.uri.fsPath) : document.uri.fsPath;
    const version = document.version;
    const epoch = previewEpoch;
    const request = ++previewRequest;
    const current = () => currentPreview(document, version, epoch, request);
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Pietto: Previewing ${name} SQL`, cancellable: true}, (_, token) => previewSql(python, launcher, source, dialect, token));
    if (result.status === 'cancelled' || !current()) return;
    if (result.status === 'failed' || result.status === 'refused') { void vscode.window.showErrorMessage(result.message); return; }
    if (!result.artifacts.length) { void vscode.window.showInformationMessage(`Pietto emitted no ${name} SQL for this file.`); return; }
    let ordinal = 0;
    if (result.artifacts.length > 1) {
      const selected = await vscode.window.showQuickPick(result.artifacts.map((artifact, index) => ({label: `${index + 1}. ${artifact.kind} ${artifact.name}`, description: `${artifact.sql.length} characters`, index})), {title: `Choose ${name} SQL artifact`});
      if (!selected || !current()) return;
      ordinal = selected.index;
    }
    if (current()) await openPreview(`${path.basename(document.uri.fsPath)}.${ordinal + 1}.${dialect}.sql`, result.artifacts[ordinal].sql, current, request);
  };
  // emit-sql --project ROOT --all --module M compiles the saved project on disk, so every file
  // of the root must be saved, and stay unchanged until the result opens.
  const previewProject = async (options: unknown) => {
    const document = savedPietto('project SQL');
    const dialect = document && dialectOf(document, options);
    if (!document || !dialect) return;
    const projects = projectsOf(document.uri.fsPath, configuredRoots());
    if (!projects.length) { void vscode.window.showInformationMessage('This file is not inside a project root of pietto.projectRoots. Run "Pietto: Select Explicit Project Root" first.'); return; }
    if (projects.length > 1) { void vscode.window.showErrorMessage(`This file belongs to two project roots: ${projects[0].root} and ${projects[1].root}. Keep one of them in projectRoots.`); return; }
    const [{root, module}] = projects;
    const unsaved = () => vscode.workspace.textDocuments.filter(item => item.isDirty && item.uri.scheme === 'file' && projectsOf(item.uri.fsPath, [root]).length);
    if (unsaved().length) { void vscode.window.showInformationMessage(`Save the changed files of the project ${root} before previewing project SQL: ${unsaved().map(item => path.relative(root, item.uri.fsPath)).join(', ')}.`); return; }
    const argument = option(options, 'emissionContract');
    const contract = argument ?? vscode.workspace.getConfiguration('pietto', document.uri).get('emissionContract', '');
    if (typeof contract !== 'string' || !contract.trim()) {
      void vscode.window.showInformationMessage(argument === undefined
        ? 'Set pietto.emissionContract to the emission contract of this project, a path relative to its root such as contract.json.'
        : 'The emissionContract argument of a Pietto project SQL preview must be a path relative to the project root.');
      return;
    }
    const name = dialectNames[dialect];
    const {python, launcher, wsl} = interpreter();
    const version = document.version;
    const epoch = previewEpoch;
    const request = ++previewRequest;
    const pending = projectPreview = {root, stale: false};
    const current = () => currentPreview(document, version, epoch, request) && !pending.stale && !unsaved().length;
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Pietto: Previewing project ${name} SQL`, cancellable: true},
      (_, token) => previewProjectSql(python, launcher, {root: wsl ? toWsl(root) : root, module, dialect, contract}, token));
    if (result.status === 'cancelled' || !current()) return;
    if (result.status === 'failed' || result.status === 'refused') { void vscode.window.showErrorMessage(result.message); return; }
    const file = path.basename(document.uri.fsPath);
    if (result.status === 'blocked') { await openPreview(`${file}.${dialect}.blocked.txt`, result.report, current, request); return; }
    if (!result.items.length) { void vscode.window.showInformationMessage(`Pietto emitted no ${name} SQL for this module.`); return; }
    let index = 0;
    if (result.items.length > 1) {
      const selected = await vscode.window.showQuickPick(result.items.map((item, ordinal) => ({label: `${ordinal + 1}. ${item.kind} ${item.name}`, description: item.status, index: ordinal})), {title: `Choose ${name} SQL of ${module}`});
      if (!selected || !current()) return;
      index = selected.index;
    }
    const item = result.items[index];
    const suffix = item.status === 'VERIFIED' ? 'sql' : `${item.status.toLowerCase().replace('_', '-')}.txt`;
    if (current()) await openPreview(`${file}.${item.kind}.${item.name}.${dialect}.${suffix}`, item.text, current, request);
  };
  const staleProject = (document: vscode.TextDocument) => {
    if (projectPreview && document.uri.scheme === 'file' && projectsOf(document.uri.fsPath, [projectPreview.root]).length) projectPreview.stale = true;
  };
  context.subscriptions.push(output, previewProvider,
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === 'pietto-sql-preview') previews.delete(document.uri.toString());
    }),
    vscode.workspace.onDidChangeTextDocument(event => staleProject(event.document)),
    vscode.workspace.onDidSaveTextDocument(staleProject),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (['pythonPath', 'pythonArguments', 'projectRoots'].some(name => event.affectsConfiguration(`pietto.${name}`))) { previewEpoch++; void restart(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void restart()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void restart()),
    vscode.commands.registerCommand('pietto.restart', restart),
    vscode.commands.registerCommand('pietto.previewPostgresSql', () => preview('postgres', undefined)),
    vscode.commands.registerCommand('pietto.previewSql', (options?: unknown) => preview(undefined, options)),
    vscode.commands.registerCommand('pietto.previewProjectSql', (options?: unknown) => previewProject(options)),
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
