import * as vscode from 'vscode';
import * as path from 'node:path';
import {ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {LanguageClient} from 'vscode-languageclient/node';
import {quickFixes, quickFixTitles} from './actions';
import {debounce, Dialect, fromWsl, isDialect, isWslLauncher, probe, projectsOf, resolveRoots, serverArguments, strings, toWsl} from './launch';
import {ModelItem, Node, relationColumns} from './models';
import {dialectNames, previewMigration, previewProjectSql, previewSql, showIfCurrent, shown} from './preview';
import {fileTargets, Location, Problem, projectTargets, range, sourceLines} from './target';

// A scope of target diagnostics: a project root, or a Pietto file outside every root.
type Scope = {readonly kind: 'root' | 'file'; readonly path: string};
const keyOf = ({kind, path: scope}: Scope) => `${kind}:${scope}`;

let client: LanguageClient | undefined;
let server: ChildProcess | undefined;
let watchers: vscode.Disposable[] = [];

const restartDelayMs = 500;

async function stop(): Promise<void> {
  const [oldClient, oldServer, oldWatchers] = [client, server, watchers];
  client = server = undefined;
  watchers = [];
  for (const watcher of oldWatchers) watcher.dispose();
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
  const interpreter = () => {
    const config = vscode.workspace.getConfiguration('pietto');
    const python = pythonOverride ?? config.get<string>('pythonPath', 'python');
    return {python, launcher: strings(config.get('pythonArguments')), wsl: isWslLauncher(python)};
  };
  const start = async () => {
    await stop();
    if (!vscode.workspace.isTrusted) return;
    const {python, launcher, wsl} = interpreter();
    const failure = await probe(python, launcher);
    if (failure !== undefined) {
      notify(`Pietto diagnostics are off: "${python}" could not run "pietto lsp" (${failure}). Install pietto 0.1.10 or later in that Python environment, or run "Pietto: Select Python Interpreter", then "Pietto: Restart Language Server".`);
      return;
    }
    const roots = configuredRoots();
    // pietto lsp does not watch the disk and reads a root again only on a document event
    // inside it, so a pietto.toml created, changed or deleted under a root restarts it.
    watchers = roots.map(root => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/pietto.toml'));
      watcher.onDidCreate(scheduled.schedule);
      watcher.onDidChange(scheduled.schedule);
      watcher.onDidDelete(scheduled.schedule);
      return watcher;
    });
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
  const restart = () => {
    scheduled.cancel();
    return (queue = queue.then(start).catch(error => output.appendLine(`Pietto language server: ${error}`)));
  };
  const scheduled = debounce(restartDelayMs, () => void restart());
  const unsavedIn = (root: string) => vscode.workspace.textDocuments.filter(item => item.isDirty && item.uri.scheme === 'file' && projectsOf(item.uri.fsPath, [root]).length);
  // The Pietto Models view: per project root, the latest `explain --project` result of its
  // saved files. A root runs one explain at a time: a new run stops the current one, waits
  // for it to exit and drops its result.
  interface Listing {nodes?: readonly Node[]; generation: number; source?: vscode.CancellationTokenSource; done: Promise<void>}
  const listings = new Map<string, Listing>();
  const modelsChanged = new vscode.EventEmitter<void>();
  const drop = (listing: Listing | undefined) => {
    if (!listing) return;
    listing.generation++;
    listing.source?.cancel();
  };
  const list = (root: string) => {
    const listing = listings.get(root) ?? {generation: 0, done: Promise.resolve()};
    listings.set(root, listing);
    drop(listing);
    if (!vscode.workspace.isTrusted || !modelsView.visible) return;
    const generation = listing.generation;
    const source = listing.source = new vscode.CancellationTokenSource();
    const {python, launcher, wsl} = interpreter();
    listing.done = listing.done.then(async () => {
      const nodes = source.token.isCancellationRequested ? undefined : await relationColumns(python, launcher, wsl ? toWsl(root) : root, source.token);
      if (nodes && listing.generation === generation) { listing.nodes = nodes; modelsChanged.fire(); }
    }).catch(error => output.appendLine(`Pietto Models: ${error}`));
  };
  const refreshModels = () => {
    for (const listing of listings.values()) drop(listing);
    for (const root of configuredRoots()) list(root);
    modelsChanged.fire();
  };
  // A saved module or pietto.toml drops the root's running result at once and lists it again
  // after the last save of a burst.
  const savedRoots = new Set<string>();
  const scheduledModels = debounce(restartDelayMs, () => {
    for (const root of savedRoots) list(root);
    savedRoots.clear();
  });
  const savedModel = (document: vscode.TextDocument) => {
    if (document.uri.scheme !== 'file' || (path.extname(document.uri.fsPath) !== '.pietto' && path.basename(document.uri.fsPath) !== 'pietto.toml')) return;
    for (const {root} of projectsOf(document.uri.fsPath, configuredRoots())) {
      drop(listings.get(root));
      savedRoots.add(root);
      scheduledModels.schedule();
    }
  };
  // The roots with unsaved files, whose node says that it shows the saved files.
  let unsavedRoots = '';
  const markUnsaved = () => {
    const now = configuredRoots().filter(root => unsavedIn(root).length).join('\0');
    if (now !== unsavedRoots) { unsavedRoots = now; modelsChanged.fire(); }
  };
  const models: vscode.TreeDataProvider<ModelItem> = {
    onDidChangeTreeData: modelsChanged.event,
    getChildren: item => {
      if (!item) return vscode.workspace.isTrusted ? configuredRoots().map(root => ({root})) : [{label: 'Trust this workspace to list Pietto models.'}];
      if (!('root' in item)) return [...item.children ?? []];
      if (!listings.has(item.root)) list(item.root);
      return [...listings.get(item.root)?.nodes ?? [{label: 'Running pietto explain --project…'}]];
    },
    getTreeItem: item => 'root' in item
      ? Object.assign(new vscode.TreeItem(shown(item.root), vscode.TreeItemCollapsibleState.Expanded), {description: unsavedIn(item.root).length ? 'shows the saved files' : undefined})
      : Object.assign(new vscode.TreeItem(item.label, item.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None), {description: item.description}),
  };
  const modelsView = vscode.window.createTreeView('pietto.models', {treeDataProvider: models});
  const previewProviders = ['pietto-sql-preview', 'pietto-migration-preview'].map(scheme => vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: uri => previews.get(uri.toString()),
  }));
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
    const unsaved = () => unsavedIn(root);
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
  // Target diagnostics (pietto.targetDiagnostics): emit-sql of a scope's saved files after a
  // save, as Warnings in their own collection. An edit of a file of the scope clears them, and
  // a run that a later save replaces or an edit makes stale shows nothing.
  const targets = vscode.languages.createDiagnosticCollection('pietto-target');
  const targetResults = new Map<string, Map<string, vscode.Diagnostic[]>>();
  const targetRuns = new Map<string, vscode.CancellationTokenSource>();
  const targetTimers = new Map<string, {schedule(): void; cancel(): void}>();
  // The scopes whose results a file can change: each root that holds it as a Pietto file, its
  // pietto.toml or its emission contract, else a Pietto file on its own.
  const scopesOf = (document: vscode.TextDocument): Scope[] => {
    if (document.uri.scheme !== 'file') return [];
    const projects = projectsOf(document.uri.fsPath, configuredRoots());
    if (!projects.length) return document.languageId === 'pietto' ? [{kind: 'file', path: document.uri.fsPath}] : [];
    return projects.filter(({root, module}) => document.languageId === 'pietto' || path.basename(module) === 'pietto.toml'
      || module === vscode.workspace.getConfiguration('pietto', vscode.Uri.file(root)).get('emissionContract')).map(({root}) => ({kind: 'root', path: root}));
  };
  // Each file shows the results of every scope that names it, in scope order.
  const publishTargets = (key: string, found = new Map<string, vscode.Diagnostic[]>()) => {
    const uris = new Set([...targetResults.get(key)?.keys() ?? [], ...found.keys()]);
    if (found.size) targetResults.set(key, found);
    else targetResults.delete(key);
    for (const uri of uris) targets.set(vscode.Uri.parse(uri), [...targetResults.values()].flatMap(result => result.get(uri) ?? []));
  };
  const stopTargets = (key: string) => {
    targetTimers.get(key)?.cancel();
    targetRuns.get(key)?.cancel();
    targetRuns.delete(key);
    publishTargets(key);
  };
  const clearTargets = () => {
    for (const key of new Set([...targetResults.keys(), ...targetRuns.keys(), ...targetTimers.keys()])) stopTargets(key);
  };
  const runTarget = async (scope: Scope, key: string) => {
    targetRuns.get(key)?.cancel();
    const config = vscode.workspace.getConfiguration('pietto', vscode.Uri.file(scope.kind === 'root' ? path.join(scope.path, 'pietto.toml') : scope.path));
    const dialect = config.get('sqlDialect', 'postgres');
    const contract = config.get('emissionContract', '');
    // emit-sql reads the disk, so a scope with an unsaved file gets no result.
    const unsaved = vscode.workspace.textDocuments.some(document => document.isDirty && scopesOf(document).some(other => keyOf(other) === key));
    if (!vscode.workspace.isTrusted || config.get('targetDiagnostics') !== true || !isDialect(dialect) || unsaved
      || (scope.kind === 'root' && (typeof contract !== 'string' || !contract.trim()))) { stopTargets(key); return; }
    const run = new vscode.CancellationTokenSource();
    targetRuns.set(key, run);
    const current = () => targetRuns.get(key) === run;
    const {python, launcher, wsl} = interpreter();
    const result = scope.kind === 'root'
      ? await projectTargets(python, launcher, {root: wsl ? toWsl(scope.path) : scope.path, dialect, contract}, run.token)
      : await fileTargets(python, launcher, wsl ? toWsl(scope.path) : scope.path, dialect, run.token);
    if (result.status === 'cancelled' || !current()) return;
    // A run that fails, or output this extension cannot read, gives one entry and no partial result.
    const problems: Problem[] = result.status === 'ready' ? result.problems : [{path: null, location: null, message: result.message, related: []}];
    const fileOf = (relative: string | null) => scope.kind === 'file' ? scope.path : path.join(scope.path, ...(relative ?? 'pietto.toml').split('/'));
    const lines = new Map<string, string[]>();
    for (const file of new Set(problems.flatMap(problem => [problem.path, ...problem.related.map(item => item.path)]).map(fileOf))) {
      lines.set(file, sourceLines(await readFile(file, 'utf8').catch(() => '')));
    }
    if (!current()) return;
    const at = (relative: string | null, location: Location | null) => {
      const file = fileOf(relative);
      return new vscode.Location(vscode.Uri.file(file), new vscode.Range(...range(lines.get(file)!, location)));
    };
    const found = new Map<string, vscode.Diagnostic[]>();
    for (const problem of problems) {
      const {uri, range: span} = at(problem.path, problem.location);
      const diagnostic = new vscode.Diagnostic(span, problem.message, vscode.DiagnosticSeverity.Warning);
      diagnostic.source = `pietto emit-sql (${dialect})`;
      diagnostic.code = problem.code;
      if (problem.related.length) diagnostic.relatedInformation = problem.related.map(item => new vscode.DiagnosticRelatedInformation(at(item.path, item.location), 'Related location'));
      found.set(uri.toString(), [...found.get(uri.toString()) ?? [], diagnostic]);
    }
    targetRuns.delete(key);
    publishTargets(key, found);
  };
  const scheduleTargets = (document: vscode.TextDocument) => {
    for (const scope of scopesOf(document)) {
      const key = keyOf(scope);
      const timer = targetTimers.get(key) ?? debounce(restartDelayMs, () => void runTarget(scope, key));
      targetTimers.set(key, timer);
      timer.schedule();
    }
  };
  // The PIE-P1000 quick fix: `pietto migrate FILE` of the saved file, shown beside it in a
  // diff editor whose migrated side is a read-only virtual document. Nothing is written.
  const migration = async (target?: vscode.Uri) => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('Trust this workspace before previewing a Pietto migration.'); return; }
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    const document = uri && vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
    if (!document || document.languageId !== 'pietto' || document.uri.scheme !== 'file') { void vscode.window.showInformationMessage('Open a saved Pietto file before previewing its migration.'); return; }
    if (document.isDirty) { void vscode.window.showInformationMessage('Save this Pietto file before previewing its migration.'); return; }
    const {python, launcher, wsl} = interpreter();
    const source = wsl ? toWsl(document.uri.fsPath) : document.uri.fsPath;
    const version = document.version;
    const epoch = previewEpoch;
    const request = ++previewRequest;
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Pietto: Previewing migration', cancellable: true}, (_, token) => previewMigration(python, launcher, source, token));
    if (result.status === 'cancelled' || !currentPreview(document, version, epoch, request)) return;
    if (result.status !== 'ready') { void vscode.window.showErrorMessage(result.message); return; }
    const name = path.basename(document.uri.fsPath);
    const migrated = vscode.Uri.from({scheme: 'pietto-migration-preview', path: `/${name}`, query: String(request)});
    // migrate keeps a leading BOM, which VS Code leaves out of the file's own side.
    previews.set(migrated.toString(), result.source.replace(/^\uFEFF/, ''));
    if (!await showIfCurrent(
      () => vscode.workspace.openTextDocument(migrated),
      () => currentPreview(document, version, epoch, request),
      () => vscode.commands.executeCommand('vscode.diff', document.uri, migrated, `${name} ↔ pietto migrate (preview)`, {preview: true}),
    )) previews.delete(migrated.toString());
  };
  context.subscriptions.push(output, ...previewProviders, {dispose: scheduled.cancel}, modelsView, modelsChanged, {dispose: scheduledModels.cancel},
    {dispose: () => { for (const listing of listings.values()) drop(listing); }},
    modelsView.onDidChangeVisibility(event => { if (event.visible) refreshModels(); }),
    targets, {dispose: () => {
      for (const timer of targetTimers.values()) timer.cancel();
      for (const run of targetRuns.values()) run.cancel();
    }},
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === 'pietto-sql-preview' || document.uri.scheme === 'pietto-migration-preview') previews.delete(document.uri.toString());
      markUnsaved();
      // pietto lsp checks a file outside every root only while it is open.
      for (const scope of scopesOf(document)) if (scope.kind === 'file') stopTargets(keyOf(scope));
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      staleProject(event.document);
      markUnsaved();
      if (event.contentChanges.length) for (const scope of scopesOf(event.document)) stopTargets(keyOf(scope));
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      staleProject(document);
      savedModel(document);
      markUnsaved();
      scheduleTargets(document);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('pietto')) { previewEpoch++; scheduled.schedule(); refreshModels(); clearTargets(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { clearTargets(); void restart(); refreshModels(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void restart(); refreshModels(); }),
    vscode.languages.registerCodeActionsProvider({scheme: 'file', language: 'pietto'}, {
      provideCodeActions: (document, _range, actionContext) => quickFixes(actionContext.diagnostics, vscode.DiagnosticSeverity.Warning).map(([fix, diagnostics]) => {
        const action = new vscode.CodeAction(quickFixTitles[fix], vscode.CodeActionKind.QuickFix);
        action.diagnostics = diagnostics;
        action.command = fix === 'selectProjectRoot'
          ? {command: 'pietto.selectProject', title: action.title}
          : {command: 'pietto.previewMigration', title: action.title, arguments: [document.uri]};
        return action;
      }),
    }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}),
    vscode.commands.registerCommand('pietto.restart', restart),
    vscode.commands.registerCommand('pietto.refreshModels', refreshModels),
    vscode.commands.registerCommand('pietto.previewPostgresSql', () => preview('postgres', undefined)),
    vscode.commands.registerCommand('pietto.previewSql', (options?: unknown) => preview(undefined, options)),
    vscode.commands.registerCommand('pietto.previewProjectSql', (options?: unknown) => previewProject(options)),
    vscode.commands.registerCommand('pietto.previewMigration', migration),
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
  // The view is declared for every workspace; it shows once a Pietto file has activated the extension.
  void vscode.commands.executeCommand('setContext', 'pietto.activated', true);
  void restart();
  return {get client() { return client; }, notices, models};
}

export function deactivate(): Promise<void> { return stop(); }
