import * as vscode from 'vscode';
import * as path from 'node:path';
import {spawn, ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {realpath} from 'node:fs/promises';
import {Candidate, DocumentInput, Observation, Reply, Request, Target, validReply} from './types';

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function canonicalUri(value: string): string {
  const uri = vscode.Uri.parse(value);
  return uri.scheme === 'file' ? vscode.Uri.file(uri.fsPath).toString() : uri.toString();
}
function normalizeReply(reply: Reply): void {
  const target = (value?: Target) => { if (value) value.uri = canonicalUri(value.uri); };
  const candidate = (value: Candidate) => target(value.definition);
  const uris = new Set<string>();
  for (const doc of reply.documents) {
    const original = doc.uri;
    doc.uri = canonicalUri(doc.uri);
    if (uris.has(doc.uri)) throw new Error('Compiler returned duplicate document identities.');
    uris.add(doc.uri);
    for (const symbol of doc.symbols) {
      symbol.id = symbol.id.replace(`${original}#`, `${doc.uri}#`);
      for (const field of [...symbol.fields ?? [], ...symbol.inputFields ?? []]) {
        if (field.id) field.id = field.id.replace(`${original}#`, `${doc.uri}#`);
        candidate(field); target(field.origin);
      }
      for (const endpoint of symbol.relationship?.endpoints ?? []) target(endpoint.definition);
    }
    doc.occurrences.forEach(candidate);
    doc.contexts.forEach(context => context.items.forEach(candidate));
    doc.diagnostics.forEach(item => item.related?.forEach(target));
  }
  const validatedTarget = (value?: Target) => { if (value && !uris.has(value.uri)) throw new Error('Compiler navigation target is outside the current snapshot.'); };
  for (const doc of reply.documents) {
    doc.occurrences.forEach(item => validatedTarget(item.definition));
    doc.contexts.forEach(context => context.items.forEach(item => validatedTarget(item.definition)));
    doc.symbols.forEach(symbol => {
      [...symbol.fields ?? [], ...symbol.inputFields ?? []].forEach(field => { validatedTarget(field.definition); validatedTarget(field.origin); });
      symbol.relationship?.endpoints.forEach(endpoint => validatedTarget(endpoint.definition));
    });
  }
}

// One worker and one coalesced refresh keep typing from building a compiler queue.
export class Bridge {
  private child?: ChildProcessWithoutNullStreams;
  private interpreter?: string;
  private pending?: {id: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout};
  constructor(private readonly script: string) {}
  async request(python: string, request: Request, timeout: number, launcherArguments: string[] = []): Promise<Reply> {
    if (this.pending) throw new Error('A compiler request is already running.');
    const identity = JSON.stringify([python, launcherArguments]);
    if (this.interpreter !== identity) this.stop();
    if (!this.child) {
      this.interpreter = identity;
      const script = process.platform === 'win32' && /^wsl(?:\.exe)?$/i.test(path.basename(python)) ? this.script.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/') : this.script;
      this.child = spawn(python, [...launcherArguments, '-I', '-B', script], {
        cwd: path.dirname(this.script), shell: false, windowsHide: true,
        env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '', PYTHONHOME: ''}
      });
      const child = this.child;
      const lines = createInterface({input: child.stdout});
      let received = 0;
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        received += chunk.length;
        if (received > 16 * 1024 * 1024) this.fail('Compiler output exceeded the analysis limit.');
      });
      lines.on('line', line => {
        received = 0;
        if (this.child !== child || !this.pending) return;
        try {
          const reply: unknown = JSON.parse(line);
          if (!validReply(reply) || reply.id !== this.pending.id) throw new Error();
          const pending = this.pending;
          this.pending = undefined;
          clearTimeout(pending.timer);
          pending.resolve(reply);
        } catch { this.fail('Compiler returned an incompatible or malformed analysis response.'); }
      });
      child.stderr.on('data', () => { /* Source and configuration are never copied to logs. */ });
      child.once('error', () => { if (this.child === child) this.fail('Python could not start. Select a compatible Python interpreter.'); });
      child.once('exit', () => { if (this.child === child) this.fail('Compiler process exited. Refresh or select a compatible Python interpreter.'); });
      child.once('close', () => lines.close());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Compiler analysis timed out. Refresh to retry.'), timeout);
      this.pending = {id: request.id, resolve, reject, timer};
      const child = this.child!;
      child.stdin.write(JSON.stringify(request) + '\n', error => { if (error && this.child === child && this.pending?.id === request.id) this.fail('Compiler input pipe closed. Refresh to retry.'); });
    });
  }
  private fail(message: string): void { this.stop(new Error(message)); }
  stop(error = new Error('Analysis cancelled.')): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const child = this.child;
    this.child = undefined;
    this.interpreter = undefined;
    child?.kill();
  }
  dispose(): void { this.stop(); }
  get processId(): number | undefined { return this.child?.pid; }
}

export class AnalysisService implements vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChange = this.change.event;
  readonly observations = new Map<string, Observation>();
  readonly memberships = new Map<string, string>();
  issues: string[] = [];
  readonly diagnostics = vscode.languages.createDiagnosticCollection('pietto');
  readonly projects = new Map<string, vscode.Uri>();
  readonly bridge: Bridge;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private queued = false;
  private epoch = 0;
  private sequence = 0;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  status = 'Open a Pietto file, or select an explicit project root.';
  compiler?: Reply['compiler'];
  pythonOverride?: string;
  metrics: {wallMs: number; compilerMs: number; documents: number}[] = [];
  constructor(private readonly context: vscode.ExtensionContext) {
    this.bridge = new Bridge(context.asAbsolutePath('adapter/analysis.py'));
    for (const uri of context.workspaceState.get<string[]>('pietto.projects', [])) {
      const root = vscode.Uri.parse(uri);
      const folder = vscode.workspace.getWorkspaceFolder(root);
      if (folder && root.scheme === 'file' && inside(folder.uri.fsPath, root.fsPath)) this.projects.set(folder.uri.toString(), root);
    }
    const watch = vscode.workspace.createFileSystemWatcher('**/*.{pietto,toml}');
    // Single-file analysis consumes editor text. Only explicit projects have disk dependencies.
    const diskChanged = (uri: vscode.Uri) => { if ([...this.projects.values()].some(root => uri.scheme === 'file' && inside(root.fsPath, uri.fsPath))) this.invalidate(); };
    this.subscriptions.push(watch, watch.onDidChange(diskChanged), watch.onDidCreate(diskChanged), watch.onDidDelete(diskChanged),
      vscode.workspace.onDidOpenTextDocument(doc => { if (doc.languageId === 'pietto') this.invalidate(); }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.document.languageId === 'pietto') this.invalidate(); }),
      vscode.workspace.onDidCloseTextDocument(doc => { if (doc.languageId === 'pietto') this.invalidate(); }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('pietto')) { this.bridge.stop(); this.invalidate(); } }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.bridge.stop();
        for (const [key, root] of this.projects) if (!vscode.workspace.getWorkspaceFolder(root)) this.projects.delete(key);
        this.invalidate();
      }));
    this.invalidate();
  }
  get(uri: vscode.Uri | string): Observation | undefined { return this.observations.get(canonicalUri(typeof uri === 'string' ? uri : uri.toString())); }
  private invalidate(): void {
    if (this.disposed) return;
    this.epoch++;
    this.observations.clear();
    this.memberships.clear(); this.issues = [];
    this.diagnostics.clear();
    this.status = vscode.workspace.isTrusted ? 'Updating compiler observations…' : 'Restricted Mode: syntax editing available. Trust is required for compiler analysis.';
    this.change.fire();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, vscode.workspace.getConfiguration('pietto').get<number>('analysisDelay', 250));
  }
  async setProject(root: vscode.Uri): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(root);
    if (root.scheme !== 'file' || !folder || !inside(folder.uri.fsPath, root.fsPath)) throw new Error('Project roots must be inside an open workspace folder.');
    if (!inside(await realpath(folder.uri.fsPath), await realpath(root.fsPath))) throw new Error('Project roots must resolve inside the open workspace folder.');
    this.projects.set(folder.uri.toString(), root);
    await this.context.workspaceState.update('pietto.projects', [...this.projects.values()].map(uri => uri.toString()));
    this.invalidate();
    await this.refresh();
  }
  async clearProjects(): Promise<void> {
    this.projects.clear();
    await this.context.workspaceState.update('pietto.projects', []);
    this.invalidate();
    await this.refresh();
  }
  async refreshCompiler(): Promise<void> { this.bridge.stop(); this.invalidate(); await this.refresh(); }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.queued = true;
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.queued && !this.disposed) {
        this.queued = false;
        await this.analyze();
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async whenIdle(): Promise<void> { if (this.timer) await this.refresh(); else await this.running; }
  private input(doc: vscode.TextDocument): DocumentInput {
    return {uri: doc.uri.toString(), path: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined, text: doc.getText(), version: doc.version};
  }
  private async analyze(): Promise<void> {
    if (!vscode.workspace.isTrusted) { this.bridge.stop(); return; }
    const epoch = this.epoch;
    this.issues = [];
    const open = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'pietto' && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled'));
    const groups: {root?: vscode.Uri; documents: DocumentInput[]}[] = [];
    try {
      if (open.length > 128) throw new Error('Analysis exceeds the 128-open-document limit.');
      for (const root of this.projects.values()) {
        // Core source selection owns project membership. Only live buffers need overlays.
        groups.push({root, documents: open.filter(doc => doc.uri.scheme === 'file' && inside(root.fsPath, doc.uri.fsPath)).map(doc => this.input(doc))});
      }
      for (const doc of open) if (!groups.some(group => group.documents.some(input => input.uri === doc.uri.toString()))) groups.push({documents: [this.input(doc)]});
      if (!groups.length) { this.status = 'Open a Pietto file, or select an explicit project root.'; this.change.fire(); return; }
      for (const group of groups) {
        if (epoch !== this.epoch || this.disposed) return;
        try {
        if (group.documents.length > 128 || group.documents.some(doc => Buffer.byteLength(doc.text) > 1024 * 1024) || group.documents.reduce((total, doc) => total + Buffer.byteLength(doc.text), 0) > 16 * 1024 * 1024) throw new Error('Analysis exceeds the 128-file, 1 MiB/file, or 16 MiB/project limit.');
        const config = vscode.workspace.getConfiguration('pietto', group.root ?? vscode.Uri.parse(group.documents[0].uri));
        const started = performance.now();
        const reply = await this.bridge.request(this.pythonOverride ?? config.get<string>('pythonPath', 'python'), {id: ++this.sequence, root: group.root?.fsPath, documents: group.documents}, config.get<number>('analysisTimeout', 15000), config.get<string[]>('pythonArguments', []));
        if (epoch !== this.epoch || this.disposed) { this.queued = true; return; }
        normalizeReply(reply);
        this.compiler = reply.compiler;
        this.metrics.push({wallMs: performance.now() - started, compilerMs: reply.elapsedMs, documents: group.documents.length});
        this.metrics = this.metrics.slice(-20);
        const inputs = new Map(group.documents.map(doc => [doc.uri, doc.version]));
        for (const doc of reply.documents) {
          const uri = vscode.Uri.parse(doc.uri);
          if (inputs.has(doc.uri) ? inputs.get(doc.uri) !== doc.version : !group.root || doc.version !== -1 || uri.scheme !== 'file' || !inside(group.root.fsPath, uri.fsPath)) throw new Error('Compiler returned a document outside the requested snapshot.');
          this.observations.set(doc.uri, doc);
          if (group.root) this.memberships.set(doc.uri, group.root.toString()); else this.memberships.delete(doc.uri);
          const diagnostics: vscode.Diagnostic[] = [];
          for (const item of doc.diagnostics) {
            // VS Code requires a range. Location-less facts use the document header and are labelled explicitly.
            const range = item.range ? toRange(item.range) : new vscode.Range(0, 0, 0, 0);
            const severity = item.severity.toLowerCase() === 'warning' ? vscode.DiagnosticSeverity.Warning : item.severity.toLowerCase() === 'info' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error;
            const diagnostic = new vscode.Diagnostic(range, item.range ? item.message : `[No source location] ${item.message}`, severity);
            diagnostic.code = item.code; diagnostic.source = 'Pietto';
            diagnostic.relatedInformation = item.related?.map(related => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.parse(related.uri), toRange(related.range)), related.message));
            diagnostics.push(diagnostic);
          }
          this.diagnostics.set(vscode.Uri.parse(doc.uri), diagnostics);
        }
        this.issues.push(...reply.issues);
        this.status = this.issues.length ? this.issues.join(' · ') : reply.ok ? 'Current compiler observations' : 'Current diagnostics; only parsed declarations are available where checking failed.';
        if (group.root) for (const input of group.documents) if (!reply.documents.some(doc => doc.uri === input.uri)) groups.push({documents: [input]});
        this.change.fire();
        } catch (error) {
          if (epoch !== this.epoch || this.disposed) return;
          const members = [...this.observations.keys()].filter(uri => group.root ? this.memberships.get(uri) === group.root.toString() : group.documents.some(doc => doc.uri === uri));
          for (const uri of members) { this.observations.delete(uri); this.memberships.delete(uri); this.diagnostics.delete(vscode.Uri.parse(uri)); }
          const scope = group.root?.fsPath ?? group.documents[0]?.uri ?? 'Document';
          this.issues.push(`${scope}: ${error instanceof Error ? error.message : 'Analysis unavailable.'}`);
          this.status = this.issues.join(' · ');
          this.change.fire();
        }
      }
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      this.observations.clear(); this.diagnostics.clear();
      this.memberships.clear();
      this.status = error instanceof Error ? error.message : 'Analysis unavailable.';
      this.change.fire();
    }
  }
  dispose(): void {
    this.disposed = true; this.epoch++; clearTimeout(this.timer);
    this.bridge.dispose(); this.diagnostics.dispose(); this.change.dispose();
    this.subscriptions.forEach(item => item.dispose());
    this.observations.clear(); this.memberships.clear(); this.projects.clear();
  }
}
export function toRange(range: import('./types').Range): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}
