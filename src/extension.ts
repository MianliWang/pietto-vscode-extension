import * as vscode from 'vscode';
import * as path from 'node:path';
import {realpath, lstat, writeFile, readFile} from 'node:fs/promises';
import {AnalysisService, inside, toRange} from './analysis';
import {Candidate, Field, Observation, Symbol, Target, contains} from './types';
import {parseConnections} from './connections';

export interface TreeNode {
  id: string; label: string; description?: string; tooltip?: string; icon?: string;
  children?: TreeNode[]; target?: Target; uri?: string; symbolId?: string; fieldPath?: string;
}
function typeDetail(item: Candidate): string {
  return [item.type, item.nullability ? `nullability: ${item.nullability}` : undefined].filter(Boolean).join(' · ');
}
function fieldNode(doc: Observation, symbol: Symbol, field: Field, group: string, index: number): TreeNode {
  const fieldPath = field.path ?? `${doc.uri}::${symbol.name}.${field.name}`;
  const id = `${doc.uri}:${symbol.id}:${group}:${field.id ?? field.name}:${index}`;
  const children: TreeNode[] = field.lineage?.map((lineage, i) => ({id: `${id}:lineage:${i}`, label: lineage, icon: 'references'})) ?? [];
  if (field.origin) children.push({id: `${id}:origin`, label: 'Compiler field origin', icon: 'references', target: field.origin, uri: doc.uri, symbolId: symbol.id});
  return {id, label: field.name,
    description: typeDetail(field), tooltip: fieldPath, icon: 'symbol-field', uri: doc.uri, symbolId: symbol.id,
    target: field.definition ?? (field.range ? {uri: doc.uri, range: field.range} : undefined),
    fieldPath, children};
}
export class Models implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly subscription: vscode.Disposable;
  constructor(readonly service: AnalysisService) { this.subscription = service.onDidChange(() => this.change.fire(undefined)); }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id; item.description = node.description; item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon ?? 'symbol-namespace');
    item.accessibilityInformation = {label: [node.label, node.description].filter(Boolean).join(', ')};
    if (node.target) item.command = {command: 'pietto.openLocation', title: 'Open declaration', arguments: [node]};
    if (node.fieldPath) item.contextValue = 'pietto.field';
    return item;
  }
  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.children ?? [];
    const documents = [...this.service.observations.values()];
    if (!documents.length) return [{id: 'status', label: this.service.status, icon: 'info'}];
    const roots = new Map<string, TreeNode>();
    for (const doc of documents) {
      const uri = vscode.Uri.parse(doc.uri);
      const workspace = vscode.workspace.getWorkspaceFolder(uri);
      const membership = this.service.memberships.get(doc.uri);
      const project = membership ? vscode.Uri.parse(membership) : undefined;
      const rootId = project ? `project:${project.toString()}` : workspace ? `workspace:${workspace.uri.toString()}` : 'untitled';
      if (!roots.has(rootId)) roots.set(rootId, {id: rootId, label: project ? `Project: ${path.basename(project.fsPath)}` : workspace?.name ?? 'Open documents', icon: 'folder', children: []});
      const moduleLabel = workspace ? path.relative((project ?? workspace.uri).fsPath, uri.fsPath).replaceAll(path.sep, '/') : uri.scheme === 'untitled' ? uri.path : path.basename(uri.fsPath);
      const children: TreeNode[] = doc.symbols.map(symbol => {
        const sections: TreeNode[] = [];
        if (symbol.physical) sections.push({id: `${doc.uri}:${symbol.id}:physical`, label: `Declared physical mapping: ${symbol.physical.schema ? `${symbol.physical.schema}.` : ''}${symbol.physical.table}`, description: 'not checked', icon: 'database'});
        if (symbol.relationship) sections.push({id: `${doc.uri}:${symbol.id}:endpoints`, label: 'Relationship endpoints', icon: 'references', children: symbol.relationship.endpoints.map((endpoint, i) => ({id: `${doc.uri}:${symbol.id}:endpoint:${i}`, label: `${endpoint.name}: ${endpoint.relation}`, description: endpoint.definition ? 'compiler identity' : 'parsed declaration', target: endpoint.definition, uri: doc.uri, symbolId: symbol.id, icon: 'symbol-reference'}))});
        if (symbol.inputFields?.length) sections.push({id: `${doc.uri}:${symbol.id}:input`, label: 'Input schema', icon: 'arrow-right', children: symbol.inputFields.map((field, i) => fieldNode(doc, symbol, field, 'input', i))});
        if (symbol.fields?.length) sections.push({id: `${doc.uri}:${symbol.id}:output`, label: symbol.kind === 'query' || symbol.kind === 'table' ? 'Output schema' : 'Fields', icon: 'symbol-class', children: symbol.fields.map((field, i) => fieldNode(doc, symbol, field, 'output', i))});
        return {id: `${doc.uri}:${symbol.id}`, label: symbol.name, description: `${symbol.kind} · ${symbol.state}`, icon: symbol.kind === 'source' ? 'database' : 'symbol-class',
          children: sections, uri: doc.uri, symbolId: symbol.id, target: symbol.selectionRange ? {uri: doc.uri, range: symbol.selectionRange} : undefined};
      });
      if (!children.length) children.push({id: `${doc.uri}:state`, label: doc.state === 'checked' ? 'No declarations' : 'Declarations unavailable; see Problems.', icon: 'info'});
      roots.get(rootId)!.children!.push({id: doc.uri, label: moduleLabel, description: doc.state, icon: 'file-code', children});
    }
    return [...this.service.issues.map((issue, i) => ({id: `issue:${i}`, label: issue, icon: 'warning'})), ...roots.values()];
  }
  find(uri: string, symbolId: string): TreeNode | undefined {
    const visit = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) { if (node.uri === uri && node.symbolId === symbolId && !node.fieldPath) return node; const found = visit(node.children ?? []); if (found) return found; }
      return undefined;
    };
    return visit(this.getChildren());
  }
  current(id: string): TreeNode | undefined {
    const visit = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) { if (node.id === id) return node; const found = visit(node.children ?? []); if (found) return found; }
      return undefined;
    };
    return visit(this.getChildren());
  }
  getParent(node: TreeNode): TreeNode | undefined {
    const visit = (nodes: TreeNode[], parent?: TreeNode): TreeNode | undefined => {
      for (const candidate of nodes) { if (candidate.id === node.id) return parent; const found = visit(candidate.children ?? [], candidate); if (found) return found; }
      return undefined;
    };
    return visit(this.getChildren());
  }
  dispose(): void { this.subscription.dispose(); this.change.dispose(); }
}

export class Connections implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly subscriptions: vscode.Disposable[];
  constructor(readonly service: AnalysisService) {
    const watch = vscode.workspace.createFileSystemWatcher('**/pietto-connections.json');
    this.subscriptions = [watch, watch.onDidChange(() => this.change.fire(undefined)), watch.onDidCreate(() => this.change.fire(undefined)), watch.onDidDelete(() => this.change.fire(undefined)),
      service.onDidChange(() => this.change.fire(undefined)), vscode.workspace.onDidChangeTextDocument(event => { if (path.basename(event.document.uri.fsPath) === 'pietto-connections.json') this.change.fire(undefined); })];
  }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id; item.description = node.description; item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon ?? 'database');
    item.accessibilityInformation = {label: [node.label, node.description].filter(Boolean).join(', ')};
    if (node.target) item.command = {command: 'pietto.openLocation', title: 'Open source', arguments: [node]};
    return item;
  }
  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) return node.children ?? [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return [{id: 'connections:no-root', label: 'Open a workspace to preview explicit connection profiles.', icon: 'info'}];
    const roots: TreeNode[] = [];
    for (const folder of folders) {
      const configUri = vscode.Uri.joinPath(folder.uri, 'pietto-connections.json');
      let text = '';
      let missing = false;
      let readIssue: string | undefined;
      try {
        if (folder.uri.scheme !== 'file') throw new Error('Connection preview requires a local or remote desktop workspace.');
        const resolvedRoot = await realpath(folder.uri.fsPath);
        const resolvedConfig = await realpath(configUri.fsPath).catch(async error => {
          if (error.code === 'ENOENT') {
            if (await lstat(configUri.fsPath).catch(() => undefined)) throw new Error('Configuration is a dangling link.');
            return path.join(resolvedRoot, 'pietto-connections.json');
          }
          throw error;
        });
        if (!inside(resolvedRoot, resolvedConfig)) throw new Error('Configuration is outside the workspace root.');
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === configUri.toString());
        if (open) { text = open.getText(); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Configuration exceeds the 1 MiB size limit.'); }
        else {
          const bytes = await readFile(resolvedConfig);
          if (bytes.length > 1024 * 1024) throw new Error('Configuration exceeds the 1 MiB size limit.');
          text = Buffer.from(bytes).toString('utf8');
        }
      } catch (error) {
        if ((error instanceof vscode.FileSystemError && error.code === 'FileNotFound') || error instanceof Error && 'code' in error && error.code === 'ENOENT') missing = true;
        else { readIssue = 'Configuration cannot be read within this workspace. Check file size, permissions, and symbolic links.'; text = 'invalid'; }
      }
      const config = parseConnections(missing ? '{"version":1,"profiles":[],"bindings":[]}' : text);
      const children: TreeNode[] = [];
      if (readIssue) children.push({id: `${folder.uri}:read-issue`, label: `Invalid configuration: ${readIssue}`, icon: 'error'});
      if (missing) children.push({id: `${folder.uri}:configure`, label: 'No preview configuration. Use Configure Connection Preview.', icon: 'gear'});
      for (const issue of config.issues) children.push({id: `${folder.uri}:issue:${children.length}`, label: `Invalid configuration: ${issue.message}`, icon: 'error'});
      for (const profile of config.profiles) {
        const fields = ['provider', 'host', 'port', 'database'] as const;
        children.push({id: `${folder.uri}:profile:${profile.id}`, label: profile.displayName, description: 'configured · not checked', icon: 'plug',
          children: fields.filter(field => profile[field] !== undefined).map(field => ({id: `${folder.uri}:profile:${profile.id}:${field}`, label: `${field}: ${profile[field]}`, icon: 'info'}))});
      }
      const matched = new Set<string>();
      for (const doc of this.service.observations.values()) {
        const uri = vscode.Uri.parse(doc.uri);
        if (uri.scheme !== 'file' || !inside(folder.uri.fsPath, uri.fsPath)) continue;
        const module = path.relative(folder.uri.fsPath, uri.fsPath).replaceAll(path.sep, '/');
        for (const source of doc.symbols.filter(symbol => symbol.kind === 'source')) {
          const ambiguous = doc.symbols.filter(symbol => symbol.kind === 'source' && symbol.name === source.name).length !== 1;
          const binding = ambiguous ? undefined : config.bindings.find(item => item.module === module && item.source === source.name);
          if (ambiguous) children.push({id: `${doc.uri}:${source.id}:ambiguous-binding`, label: `${module} · ${source.name}: declaration identity is ambiguous`, description: 'unbound · not checked', icon: 'warning'});
          if (binding) matched.add(JSON.stringify([module, source.name]));
          const profile = binding && config.profiles.find(item => item.id === binding.profile);
          const mappings = binding?.tables?.map((mapping, i) => ({id: `${doc.uri}:${source.id}:mapping:${i}`, label: `${mapping.declaration}: ${mapping.schema ? `${mapping.schema}.` : ''}${mapping.table}`, description: `configured mapping · ${mapping.declaration === source.name ? 'source declaration present' : doc.symbols.some(symbol => symbol.kind === 'table' && symbol.name === mapping.declaration) ? 'table declaration present; source association unknown' : 'declaration unavailable'} · not checked`, icon: 'symbol-class'})) ?? [];
          if (source.physical) mappings.unshift({id: `${doc.uri}:${source.id}:declared-physical`, label: `Declared physical mapping: ${source.physical.schema ? `${source.physical.schema}.` : ''}${source.physical.table}`, description: 'not checked', icon: 'database'});
          if (profile && source.provider && source.provider !== profile.provider && source.provider !== `${profile.provider}.table`) mappings.push({id: `${doc.uri}:${source.id}:provider`, label: 'Declared provider differs from the configured profile provider.', description: 'not checked', icon: 'warning'});
          children.push({id: `${doc.uri}:${source.id}:connection`, label: `${module} · ${source.name}`, description: `declared · ${profile ? 'configured' : 'unbound'} · not checked`,
            tooltip: `Provider declaration: ${source.provider ?? 'unknown'}. Profile: ${profile?.displayName ?? 'unbound'}. Live connectivity and physical schema are not checked.`,
            uri: doc.uri, symbolId: source.id, target: source.selectionRange ? {uri: doc.uri, range: source.selectionRange} : undefined, children: mappings});
        }
      }
      for (const binding of config.bindings) if (!matched.has(JSON.stringify([binding.module, binding.source]))) children.push({id: `${folder.uri}:unavailable:${children.length}`, label: `${binding.module} · ${binding.source}: binding target unavailable`, description: `${binding.profile} · not checked`, icon: 'warning'});
      if (!this.service.observations.size) children.push({id: `${folder.uri}:analysis`, label: this.service.status, icon: 'info'});
      roots.push({id: `${folder.uri}:connections`, label: folder.name, description: 'Preview only · not checked', icon: 'folder', children});
    }
    return roots;
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.change.dispose(); }
}

const keywordCandidates = ['shape', 'source', 'table', 'query', 'from', 'select', 'where', 'let', 'join', 'on', 'group', 'by', 'order', 'limit', 'import', 'export', 'as', 'and', 'or', 'not', 'true', 'false', 'null'];
const symbolKind = (kind: string) => kind === 'source' ? vscode.SymbolKind.Namespace : kind === 'field' ? vscode.SymbolKind.Field : kind === 'query' ? vscode.SymbolKind.Function : vscode.SymbolKind.Class;
async function current(service: AnalysisService, doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<Observation | undefined> {
  const version = doc.version;
  let observation = service.get(doc.uri);
  if (observation?.version !== version) { await service.whenIdle(); observation = service.get(doc.uri); }
  return !token.isCancellationRequested && doc.version === version && observation?.version === version ? observation : undefined;
}
async function occurrence(service: AnalysisService, doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<(Candidate & {range: import('./types').Range}) | undefined> {
  const observation = await current(service, doc, token);
  return observation?.occurrences.filter(item => contains(item.range, position)).sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line) || (a.range.end.character - a.range.start.character) - (b.range.end.character - b.range.start.character))[0];
}
export function activate(context: vscode.ExtensionContext) {
  const service = new AnalysisService(context);
  const models = new Models(service);
  const connections = new Connections(service);
  const tree = vscode.window.createTreeView('pietto.models', {treeDataProvider: models, showCollapseAll: true});
  const connectionTree = vscode.window.createTreeView('pietto.connections', {treeDataProvider: connections, showCollapseAll: true});
  const selector: vscode.DocumentSelector = [{language: 'pietto', scheme: 'file'}, {language: 'pietto', scheme: 'untitled'}];
  context.subscriptions.push(service, models, connections, tree, connectionTree,
    vscode.languages.registerHoverProvider(selector, {async provideHover(doc, position, token) {
      const item = await occurrence(service, doc, position, token);
      if (!item) return;
      const markdown = new vscode.MarkdownString(); markdown.isTrusted = false; markdown.supportHtml = false;
      markdown.appendText(`${item.name} (${item.kind})${typeDetail(item) ? `\n${typeDetail(item)}` : ''}`);
      if (item.documentation) markdown.appendText(`\n\n${item.documentation}`);
      if (item.definition) markdown.appendText(`\nDefinition: ${vscode.Uri.parse(item.definition.uri).fsPath || item.definition.uri}:${item.definition.range.start.line + 1}`);
      return new vscode.Hover(markdown, toRange(item.range));
    }}),
    vscode.languages.registerDefinitionProvider(selector, {async provideDefinition(doc, position, token) {
      const item = await occurrence(service, doc, position, token);
      return item?.definition ? new vscode.Location(vscode.Uri.parse(item.definition.uri), toRange(item.definition.range)) : undefined;
    }}),
    vscode.languages.registerCompletionItemProvider(selector, {async provideCompletionItems(doc, position, token) {
      const version = doc.version;
      const observation = await current(service, doc, token);
      if (token.isCancellationRequested || doc.version !== version) return [];
      const contexts = observation?.version === doc.version ? observation.contexts.filter(item => contains(item.range, position)) : [];
      const context = contexts.sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line) || (a.range.end.character - a.range.start.character) - (b.range.end.character - b.range.start.character))[0];
      const peers = context ? contexts.filter(item => JSON.stringify(item.range) === JSON.stringify(context.range)) : [];
      const prefix = /[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_0-9]*)*$/.exec(doc.lineAt(position.line).text.slice(0, position.character))?.[0] ?? '';
      const qualifier = prefix.includes('.') ? prefix.slice(0, prefix.lastIndexOf('.') + 1) : '';
      if (context?.kind === 'excluded') return [];
      const candidates: Candidate[] = peers.flatMap(item => item.items);
      if (!qualifier && (!context || peers.some(item => item.kind === 'global' || item.kind === 'declaration'))) candidates.push(...keywordCandidates.map(name => ({name, kind: 'keyword'})));
      const unique = new Map(candidates.filter(candidate => !qualifier || candidate.name.startsWith(qualifier)).map(candidate => [`${candidate.kind}:${candidate.name}`, candidate]));
      return [...unique.values()].map(candidate => {
        const item = new vscode.CompletionItem(candidate.name, candidate.kind === 'field' ? vscode.CompletionItemKind.Field : candidate.kind === 'type' ? vscode.CompletionItemKind.TypeParameter : candidate.kind === 'keyword' ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Variable);
        item.detail = typeDetail(candidate); item.sortText = `${candidate.kind === 'keyword' ? '1' : '0'}:${candidate.name}`;
        if (qualifier) { item.range = new vscode.Range(position.line, position.character - prefix.length, position.line, position.character); item.insertText = candidate.name; }
        if (candidate.documentation) { const markdown = new vscode.MarkdownString(); markdown.appendText(candidate.documentation); item.documentation = markdown; }
        return item;
      });
    }}, '.'),
    vscode.languages.registerDocumentSymbolProvider(selector, {async provideDocumentSymbols(doc, token) {
      const observation = await current(service, doc, token);
      if (observation?.version !== doc.version) return [];
      return observation.symbols.filter(symbol => symbol.range && symbol.selectionRange).map(symbol => {
        const outline = new vscode.DocumentSymbol(symbol.name, `${symbol.kind} · ${symbol.state}`, symbolKind(symbol.kind), toRange(symbol.range!), toRange(symbol.selectionRange!));
        outline.children = (symbol.fields ?? []).filter(field => field.range && (!field.definition || field.definition.uri === doc.uri.toString()) && toRange(symbol.range!).contains(toRange(field.range))).map(field => new vscode.DocumentSymbol(field.name, typeDetail(field), vscode.SymbolKind.Field, toRange(field.range!), toRange(field.range!)));
        return outline;
      });
    }}),
    vscode.languages.registerFoldingRangeProvider(selector, {provideFoldingRanges(doc) {
      const result: vscode.FoldingRange[] = [];
      for (let line = 0; line < doc.lineCount - 1; line++) {
        const text = doc.lineAt(line).text;
        if (text.trimStart().startsWith('#')) continue;
        if (!/:\s*(?:#.*)?$/.test(text)) continue;
        const indent = doc.lineAt(line).firstNonWhitespaceCharacterIndex;
        let end = line;
        for (let i = line + 1; i < doc.lineCount; i++) {
          if (!doc.lineAt(i).isEmptyOrWhitespace && doc.lineAt(i).firstNonWhitespaceCharacterIndex <= indent) break;
          end = i;
        }
        if (end > line) result.push(new vscode.FoldingRange(line, end));
      }
      return result;
    }}),
    vscode.commands.registerCommand('pietto.refresh', () => service.refreshCompiler()),
    vscode.commands.registerCommand('pietto.openLocation', async (node: TreeNode) => {
      if (!node.target || !node.uri || !service.get(node.uri)?.symbols.some(symbol => symbol.id === node.symbolId)) return;
      const current = models.current(node.id);
      const symbol = service.get(node.uri)?.symbols.find(symbol => symbol.id === node.symbolId);
      const target = current?.target ?? (node.id.endsWith(':connection') && symbol?.selectionRange ? {uri: node.uri, range: symbol.selectionRange} : undefined);
      if (!target) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(toRange(target.range).start, toRange(target.range).end);
      editor.revealRange(toRange(target.range));
    }),
    vscode.commands.registerCommand('pietto.copyFieldPath', async (node: TreeNode) => { const current = models.current(node.id); if (current?.fieldPath) await vscode.env.clipboard.writeText(current.fieldPath); }),
    vscode.commands.registerCommand('pietto.reveal', async () => {
      const editor = vscode.window.activeTextEditor; if (!editor) return;
      const symbol = service.get(editor.document.uri)?.symbols.find(item => item.range && contains(item.range, editor.selection.active));
      const node = symbol && models.find(editor.document.uri.toString(), symbol.id);
      if (node) await tree.reveal(node, {select: true, focus: true, expand: true});
    }),
    vscode.commands.registerCommand('pietto.selectPython', async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showInformationMessage('Trust this workspace before selecting an interpreter for compiler analysis.'); return; }
      const uri = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const input = await vscode.window.showInputBox({title: 'Pietto Python Interpreter', prompt: 'Absolute Python executable path containing the compatible Pietto compiler', value: vscode.workspace.getConfiguration('pietto', uri).get('pythonPath', 'python')});
      if (input) {
        const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
        if (folder) await vscode.workspace.getConfiguration('pietto', folder.uri).update('pythonPath', input, vscode.ConfigurationTarget.WorkspaceFolder);
        else { service.pythonOverride = input; service.bridge.stop(); }
        await service.refresh();
      }
    }),
    vscode.commands.registerCommand('pietto.selectProject', async () => {
      const roots = vscode.workspace.workspaceFolders ?? [];
      const choice = await vscode.window.showQuickPick([...roots.map(folder => ({label: folder.name, description: folder.uri.fsPath, uri: folder.uri})), {label: 'Choose a subfolder…', description: 'Inside an open workspace', uri: undefined}], {title: 'Select Explicit Pietto Project Root', placeHolder: 'Core pietto.toml is loaded only from the chosen root.'});
      if (!choice) return;
      const uri = choice.uri ?? (await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: roots[0]?.uri}))?.[0];
      if (uri) { try { await service.setProject(uri); } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Invalid project root.'); } }
    }),
    vscode.commands.registerCommand('pietto.clearProject', () => service.clearProjects()),
    vscode.commands.registerCommand('pietto.configureConnections', async () => {
      const folder = await vscode.window.showWorkspaceFolderPick({placeHolder: 'Workspace for the extension-owned connection preview configuration'}); if (!folder) return;
      if (folder.uri.scheme !== 'file') return;
      const resolvedRoot = await realpath(folder.uri.fsPath);
      const file = path.join(resolvedRoot, 'pietto-connections.json');
      let resolved = file;
      try {
        await lstat(file); // Existing dangling links are rejected, never followed for writes.
        resolved = await realpath(file);
        if (!inside(resolvedRoot, resolved)) throw new Error('Connection configuration resolves outside the workspace.');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        const entry = await lstat(file).catch(() => undefined);
        if (entry) throw new Error('Connection configuration is a dangling link.');
        await writeFile(file, '{\n  "version": 1,\n  "profiles": [],\n  "bindings": []\n}\n', {flag: 'wx'});
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(resolved)));
    }));
  return {service, models, connections};
}
export function deactivate(): void { /* Subscriptions own processes and watches. */ }
