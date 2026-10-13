import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AnalysisService, Bridge } from '../../src/analysis';
import type { Reply, Request } from '../../src/types';

interface ExtensionApi {
  service: AnalysisService;
  models: vscode.TreeDataProvider<unknown>;
  connections: vscode.TreeDataProvider<unknown> & { refresh?: () => void | Promise<void> };
}

const source = [
  'shape User:',
  '    id: Int not null',
  '    email: Text nullable',
  '',
  'source users: User is postgres.table("public.users")',
  '',
  'query emails:',
  '    from users',
  '    where email is not null',
  '    select:',
  '        id',
  '        email',
  '',
].join('\n');

function position(document: vscode.TextDocument, text: string, last = false): vscode.Position {
  const content = document.getText();
  const occurrences = /^[A-Za-z_][A-Za-z_0-9]*$/.test(text)
    ? [...content.matchAll(new RegExp(`\\b${text}\\b`, 'g'))].map(match => match.index)
    : undefined;
  const offset = occurrences ? (last ? occurrences.at(-1) : occurrences[0]) ?? -1 : last ? content.lastIndexOf(text) : content.indexOf(text);
  assert.ok(offset >= 0, `Missing test token ${text}`);
  return document.positionAt(offset);
}

async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

function label(item: vscode.TreeItem): string {
  return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
}

async function tree(provider: vscode.TreeDataProvider<unknown>, parent?: unknown, depth = 0): Promise<vscode.TreeItem[]> {
  const nodes = await provider.getChildren(parent) ?? [];
  const result: vscode.TreeItem[] = [];
  for (const node of nodes) {
    const item = await provider.getTreeItem(node);
    result.push(item);
    if (depth < 4 && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) result.push(...await tree(provider, node, depth + 1));
  }
  return result;
}

export async function run(): Promise<void> {
  const root = process.env.PIETTO_HOST_ROOT!;
  const workspace = process.env.PIETTO_HOST_WORKSPACE!;
  const other = process.env.PIETTO_HOST_OTHER!;
  const results: { name: string; ms: number; compiler?: Reply['compiler'] }[] = [];
  const performanceEvidence: Record<string, unknown> = {};
  let failure: { stage: string; name: string; message: string; stack?: string } | undefined;
  const projectSteps: { step: string; elapsedMs: number }[] = [];
  let completed = false;
  const stage = async (name: string, action: () => Promise<void>) => {
    const started = performance.now();
    try { await action(); }
    catch (error) {
      failure = {
        stage: name,
        name: error instanceof Error ? error.name : 'Non-Error rejection',
        message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'The host rejected without an Error message.',
        stack: error instanceof Error ? error.stack : undefined,
      };
      console.error(`FAIL ${name}: ${failure.name}: ${failure.message}`);
      if (failure.stack) console.error(failure.stack);
      throw error;
    }
    results.push({ name, ms: performance.now() - started, compiler: api.service.compiler });
    console.log(`PASS ${name}`);
  };
  const extension = vscode.extensions.getExtension<ExtensionApi>('MianliWang.pietto-vscode-extension');
  assert.ok(extension, 'Pietto extension must be discovered by the real editor host.');
  if (process.env.PIETTO_HOST_INSTALLED === '1') {
    assert.ok(process.env.PIETTO_HOST_INSTALLED_PATH);
    assert.equal(path.resolve(extension.extensionPath), path.resolve(process.env.PIETTO_HOST_INSTALLED_PATH!));
  }
  const api = await extension.activate();
  let compilerRequests = 0;
  const request = api.service.bridge.request.bind(api.service.bridge);
  const workload = (input: Request, reply?: Reply) => ({
    projectRoot: input.root ?? null,
    inputDocuments: input.documents.map(document => ({ uri: document.uri, version: document.version, utf8Bytes: Buffer.byteLength(document.text), lines: document.text.split('\n').length })),
    observedDocuments: reply?.documents.map(document => ({ uri: document.uri, version: document.version, state: document.state })),
  });
  let warmRequests: unknown[] | undefined;
  api.service.bridge.request = async (...args): Promise<Reply> => {
    compilerRequests++;
    const started = performance.now();
    const workerCold = api.service.bridge.processId === undefined;
    const reply = await request(...args);
    const measurement = { wallMs: performance.now() - started, compilerMs: reply.elapsedMs, workerCold, compiler: reply.compiler, ...workload(args[1], reply) };
    if (reply.ok && !performanceEvidence.firstSuccessfulReply) performanceEvidence.firstSuccessfulReply = measurement;
    warmRequests?.push(measurement);
    return reply;
  };
  await api.service.clearProjects();
  const file = path.join(workspace, 'single.pietto');
  writeFileSync(file, source);
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  try {
    await stage('single file real diagnostics, outline, hover, completion, field definition and native model tree', async () => {
      await api.service.whenIdle();
      assert.equal(document.languageId, 'pietto');
      assert.equal(api.service.get(document.uri)?.state, 'checked', api.service.status);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
      assert.ok(symbols?.some(symbol => symbol.name === 'User'));
      assert.ok(symbols?.some(symbol => symbol.name === 'users'));
      assert.ok(symbols?.some(symbol => symbol.name === 'emails'));
      const fieldPosition = position(document, 'email', true);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, fieldPosition);
      const hoverText = hovers?.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
      assert.match(hoverText, /Text/);
      assert.match(hoverText, /nullab/i);
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, fieldPosition);
      assert.ok(completions?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'email'));
      const declarations = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position(document, 'users', true));
      assert.ok(declarations?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'users'), 'FROM completion needs real visible declarations.');
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, fieldPosition);
      assert.ok(definitions?.some(definition => {
        const target = 'targetUri' in definition ? definition.targetUri : definition.uri;
        const range = 'targetUri' in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
        return target.toString() === document.uri.toString() && range.start.line === 2;
      }));
      const requestCountBeforeRefresh = compilerRequests;
      const singleFileScopes = vscode.workspace.textDocuments.filter(input => input.languageId === 'pietto' && ['file', 'untitled'].includes(input.uri.scheme)).length;
      const requestedVersion = document.version;
      const pending = api.service.refreshCompiler();
      assert.equal(api.service.get(document.uri), undefined, 'Refresh must expose the real missing-current-observation interval.');
      const pendingDefinitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, fieldPosition);
      await pending;
      assert.equal(api.service.get(document.uri)?.version, requestedVersion);
      assert.ok(pendingDefinitions?.some(definition => {
        const target = 'targetUri' in definition ? definition.targetUri : definition.uri;
        const range = 'targetUri' in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
        return target.toString() === document.uri.toString() && range.start.line === 2 && document.getText(range) === 'email';
      }), 'Definition must await the shared pending worker and return the current field identity.');
      assert.equal(compilerRequests - requestCountBeforeRefresh, singleFileScopes, 'Waiting for a pending definition must not add a second compiler traversal.');
      performanceEvidence.pendingDefinition = { requestedVersion, singleFileScopes, compilerRequests: compilerRequests - requestCountBeforeRefresh, targetUri: document.uri.toString(), targetLine: 2 };
      await vscode.commands.executeCommand('pietto.models.focus');
      const items = await tree(api.models);
      assert.ok(items.some(item => label(item) === 'User'));
      assert.ok(items.some(item => label(item) === 'email'));
      assert.ok(items.some(item => typeof item.description === 'string' && /Text/.test(item.description)));
      assert.equal(new Set(items.filter(item => item.id).map(item => item.id)).size, items.filter(item => item.id).length);
      const fieldItem = items.find(item => label(item) === 'email' && item.command);
      assert.ok(fieldItem?.command);
      await vscode.commands.executeCommand(fieldItem.command.command, ...(fieldItem.command.arguments ?? []));
      assert.equal(vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection), 'email');
      const clipboard = await vscode.env.clipboard.readText();
      try {
        await vscode.commands.executeCommand('pietto.copyFieldPath', fieldItem.command.arguments?.[0]);
        assert.match(await vscode.env.clipboard.readText(), /\.email$/);
      } finally { await vscode.env.clipboard.writeText(clipboard); }
      const identities = items.map(item => item.id);
      await api.service.refresh();
      assert.deepEqual((await tree(api.models)).map(item => item.id), identities);
      performanceEvidence.initialStageMetrics = api.service.metrics.map(metric => ({ ...metric }));
      performanceEvidence.initialSingleBuffer = { uri: document.uri.toString(), version: document.version, utf8Bytes: Buffer.byteLength(document.getText()), lines: document.lineCount, compiler: api.service.compiler };
    });
    await stage('automatic unsaved edit reaches current checked observations through the configured debounce', async () => {
      const beforeVersion = document.version;
      let requestedVersion = beforeVersion + 1;
      const debounceMs = vscode.workspace.getConfiguration('pietto', document.uri).get<number>('analysisDelay', 250);
      const started = performance.now();
      let subscription: vscode.Disposable | undefined;
      let deadline: NodeJS.Timeout | undefined;
      const updated = new Promise<void>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Automatic current-version editor analysis did not update within 15000 ms.')), 15000);
        subscription = api.service.onDidChange(() => {
          const observation = api.service.get(document.uri);
          const field = observation?.symbols.find(symbol => symbol.name === 'User')?.fields?.find(item => item.name === 'email');
          if (observation?.version !== requestedVersion || document.version !== requestedVersion || observation.state !== 'checked' || field?.type !== 'Int') return;
          performanceEvidence.automaticEdit = {
            wallMs: performance.now() - started, debounceMs, deadlineMs: 15000,
            uri: document.uri.toString(), beforeVersion, requestedVersion,
            utf8Bytes: Buffer.byteLength(document.getText()), lines: document.lineCount,
            observedType: field.type, compiler: api.service.compiler,
            observation: 'service.onDidChange with the requested document version and checked state; no refresh/whenIdle flush',
          };
          resolve();
        });
      });
      try {
        await replace(document, source.replace('email: Text nullable', 'email: Int nullable'));
        requestedVersion = document.version;
        await updated;
        assert.equal(document.isDirty, true);
        assert.equal(readFileSync(document.uri.fsPath, 'utf8'), source);
      } finally {
        subscription?.dispose();
        clearTimeout(deadline);
        await replace(document, source);
        await api.service.whenIdle();
      }
    });
    await stage('qualified completion inserts one field path and source strings/comments have no authoritative candidates', async () => {
      await replace(document, source.replace('        email\n', '        users.\n'));
      await api.service.whenIdle();
      const cursor = position(document, 'users.', true).translate(0, 'users.'.length);
      const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, cursor, '.');
      const field = completion?.items.find(item => /(?:^|\.)email$/.test(typeof item.label === 'string' ? item.label : item.label.label));
      assert.ok(field, 'Qualified field completion must come from compiler-owned schema facts.');
      const range = field.textEdit?.range ?? (field.range instanceof vscode.Range ? field.range : field.range?.replacing) ?? new vscode.Range(cursor, cursor);
      const insert = field.textEdit?.newText ?? (typeof field.insertText === 'string' ? field.insertText : field.insertText?.value) ?? (typeof field.label === 'string' ? field.label : field.label.label);
      const line = document.lineAt(cursor.line).text;
      const edited = line.slice(0, range.start.character) + insert + line.slice(range.end.character);
      assert.ok(!edited.includes('users.users.'), edited);
      assert.match(edited, /users\.email/);
      assert.notEqual(api.service.get(document.uri)?.state, 'checked', 'Completion recovery must not turn incomplete source into a compiled model.');
      await replace(document, source.replace('        email\n', '        email # email\n'));
      await api.service.whenIdle();
      const comment = position(document, '# email').translate(0, 4);
      const string = position(document, 'public.users').translate(0, 4);
      for (const cursor of [comment, string]) {
        const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, cursor);
        assert.ok(!items?.items.some(item => [vscode.CompletionItemKind.Field, vscode.CompletionItemKind.Variable, vscode.CompletionItemKind.TypeParameter].includes(item.kind!)));
      }
      await replace(document, source);
      await api.service.whenIdle();
    });
    await stage('unsaved errors update and fixing them clears obsolete diagnostics and models', async () => {
      await replace(document, source.replace('    where email is not null', '    where missing == 1'));
      await api.service.whenIdle();
      assert.equal(document.isDirty, true);
      assert.ok(vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error));
      assert.notEqual(api.service.get(document.uri)?.state, 'checked');
      assert.ok(!api.service.get(document.uri)?.symbols.some(symbol => symbol.state === 'checked' && symbol.name === 'emails'));
      await replace(document, source);
      await api.service.whenIdle();
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      assert.equal(api.service.get(document.uri)?.version, document.version);
      assert.equal(api.service.get(document.uri)?.state, 'checked');
    });
    await stage('incomplete source keeps editing assistance without stale current observations', async () => {
      await replace(document, source + 'query incomplete:\n    from\n');
      await api.service.whenIdle();
      assert.ok(vscode.languages.getDiagnostics(document.uri).length > 0);
      assert.notEqual(api.service.get(document.uri)?.state, 'checked');
      const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(document.lineCount - 1, 0));
      assert.ok(completion?.items.length);
      await replace(document, source);
      await api.service.whenIdle();
    });
    await stage('delayed older compiler reply cannot overwrite an unsaved newer version', async () => {
      const request = api.service.bridge.request.bind(api.service.bridge);
      let release: (() => void) | undefined;
      let observed: (() => void) | undefined;
      const entered = new Promise<void>(resolve => { observed = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      let delayed = false;
      api.service.bridge.request = async (...args): Promise<Reply> => {
        const reply = await request(...args);
        if (!delayed) { delayed = true; observed!(); await hold; }
        return reply;
      };
      try {
        await replace(document, source.replace('query emails:', 'query older:'));
        const running = api.service.refresh();
        await entered;
        await replace(document, source.replace('query emails:', 'query newer:'));
        release!();
        await running;
        await api.service.whenIdle();
        const observation = api.service.get(document.uri);
        assert.equal(observation?.version, document.version);
        assert.ok(observation?.symbols.some(symbol => symbol.name === 'newer'));
        assert.ok(!observation?.symbols.some(symbol => symbol.name === 'older'));
      } finally { api.service.bridge.request = request; }
      await replace(document, source);
      await api.service.whenIdle();
    });
    await stage('BOM, CRLF, Unicode path and UTF-16 positions select intended fields', async () => {
      const unicodeFile = path.join(workspace, 'modèles😀.pietto');
      writeFileSync(unicodeFile, '\uFEFF' + source.replace('    where email is not null', '    where "😀" == email').replace(/\n/g, '\r\n'));
      const unicode = await vscode.workspace.openTextDocument(unicodeFile);
      await api.service.whenIdle();
      assert.equal(api.service.get(unicode.uri)?.state, 'checked', api.service.status);
      const fieldPosition = position(unicode, 'email\r\n');
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', unicode.uri, fieldPosition);
      assert.ok(hovers?.length);
      assert.equal(unicode.getText(hovers![0].range), 'email');
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', unicode.uri, fieldPosition);
      assert.ok(definitions?.some(definition => {
        const target = 'targetUri' in definition ? definition.targetUri : definition.uri;
        return target.toString() === unicode.uri.toString();
      }));
    });
    await stage('same-spelled models remain isolated across real workspace folders', async () => {
      const secondFile = path.join(other, 'single.pietto');
      writeFileSync(secondFile, source.replace('Text nullable', 'Int nullable'));
      const second = await vscode.workspace.openTextDocument(secondFile);
      await api.service.whenIdle();
      const firstEmail = api.service.get(document.uri)?.symbols.find(symbol => symbol.name === 'User')?.fields?.find(field => field.name === 'email');
      const secondEmail = api.service.get(second.uri)?.symbols.find(symbol => symbol.name === 'User')?.fields?.find(field => field.name === 'email');
      assert.equal(firstEmail?.type, 'Text');
      assert.equal(secondEmail?.type, 'Int');
      assert.notEqual(api.service.get(document.uri)?.symbols[0].id, api.service.get(second.uri)?.symbols[0].id);
    });
    await stage('explicit project imports, re-exports and unsaved dependency edits use canonical owners', async () => {
      const projectStarted = performance.now();
      const step = (name: string) => {
        projectSteps.push({ step: name, elapsedMs: performance.now() - projectStarted });
        console.log(`STEP project: ${name}`);
      };
      step('select released WSL interpreter');
      const settings = vscode.workspace.getConfiguration('pietto');
      const projectPython = process.env.PIETTO_TEST_PROJECT_PYTHON ?? path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe');
      const rootInWsl = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
      const projectArguments = JSON.parse(process.env.PIETTO_TEST_PROJECT_PYTHON_ARGUMENTS ?? JSON.stringify(['-d', 'Ubuntu', '--', rootInWsl + '/.local/release-venv-wsl/bin/python'])) as string[];
      await settings.update('pythonPath', projectPython, vscode.ConfigurationTarget.Global);
      await settings.update('pythonArguments', projectArguments, vscode.ConfigurationTarget.Global);
      step('copy project fixture and select explicit root');
      const project = path.join(workspace, 'project');
      cpSync(path.join(root, 'examples', 'project'), project, { recursive: true });
      await api.service.setProject(vscode.Uri.file(project));
      const users = await vscode.workspace.openTextDocument(path.join(project, 'models', 'users.pietto'));
      const emails = await vscode.workspace.openTextDocument(path.join(project, 'models', 'emails.pietto'));
      await api.service.whenIdle();
      step('verify canonical imported definition');
      assert.equal(api.service.get(emails.uri)?.state, 'checked', api.service.status);
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', emails.uri, position(emails, 'people', true));
      assert.ok(definitions?.some(definition => ('targetUri' in definition ? definition.targetUri : definition.uri).toString() === users.uri.toString()));
      step('verify imported field completion');
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', emails.uri, position(emails, 'email', true));
      const names = completions?.items.map(item => typeof item.label === 'string' ? item.label : item.label.label) ?? [];
      assert.ok(names.includes('email'));
      assert.ok(!names.includes('local_only'));
      step('edit imported buffer without saving');
      const original = readFileSync(users.uri.fsPath, 'utf8');
      await replace(users, original.replace('email: Text nullable', 'email: Int nullable'));
      await api.service.whenIdle();
      step('verify imported edit observations and unchanged disk bytes');
      assert.equal(users.isDirty, true);
      const field = api.service.get(emails.uri)?.symbols.find(symbol => symbol.name === 'emails')?.fields?.find(item => item.name === 'email');
      assert.equal(field?.type, 'Int');
      assert.equal(readFileSync(users.uri.fsPath, 'utf8'), original, 'Imported editor buffer must not auto-save or rewrite the original file.');
      await replace(users, original);
      await api.service.whenIdle();
      step('open source excluded by project configuration');
      const excludedFile = path.join(project, 'scratch', 'excluded.pietto');
      mkdirSync(path.dirname(excludedFile), { recursive: true });
      writeFileSync(excludedFile, 'shape Independent:\n    value: Bool not null\n');
      const excluded = await vscode.workspace.openTextDocument(excludedFile);
      await api.service.whenIdle();
      step('verify excluded source is checked without project membership');
      assert.equal(api.service.get(excluded.uri)?.state, 'checked');
      assert.equal(api.service.memberships.get(excluded.uri.toString()), undefined);
      const projectNodes = await api.models.getChildren() ?? [];
      const projectItems = await Promise.all(projectNodes.map(async node => ({ node, item: await api.models.getTreeItem(node) })));
      const projectNode = projectItems.find(entry => label(entry.item).startsWith('Project:'))?.node;
      assert.ok(projectNode);
      assert.ok(!(await tree(api.models, projectNode)).some(item => label(item) === 'Independent'), 'Excluded files must not acquire project membership from their directory.');
      assert.ok((await tree(api.models)).some(item => label(item) === 'Independent'));
      step('set missing interpreter only in second workspace folder');
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(other));
      assert.ok(folder);
      const folderSettingsFile = path.join(other, '.vscode', 'settings.json');
      const originalSettingsText = readFileSync(folderSettingsFile, 'utf8');
      const originalFolderValue = vscode.workspace.getConfiguration('pietto', folder.uri).inspect<string>('pythonPath')?.workspaceFolderValue;
      const saveFolderSettings = async (text: string, expectedValue: string | undefined) => {
        const before = vscode.workspace.getConfiguration('pietto', folder.uri).inspect<string>('pythonPath')?.workspaceFolderValue;
        let subscription: vscode.Disposable | undefined;
        let deadline: NodeJS.Timeout | undefined;
        const changed = new Promise<void>((resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('The real workspace configuration did not read back the saved interpreter within 15000 ms.')), 15000);
          subscription = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('pietto.pythonPath', folder.uri) && vscode.workspace.getConfiguration('pietto', folder.uri).inspect<string>('pythonPath')?.workspaceFolderValue === expectedValue) resolve();
          });
        });
        try {
          writeFileSync(folderSettingsFile, text);
          if (before !== expectedValue) await changed;
          assert.equal(vscode.workspace.getConfiguration('pietto', folder.uri).inspect<string>('pythonPath')?.workspaceFolderValue, expectedValue);
        } finally { subscription?.dispose(); clearTimeout(deadline); }
      };
      const missingInterpreter = path.join(root, '.local', 'missing-folder-python.exe');
      try {
        await saveFolderSettings(JSON.stringify({ ...JSON.parse(originalSettingsText), 'pietto.pythonPath': missingInterpreter }, null, 2), missingInterpreter);
        await api.service.whenIdle();
        step('verify independent folder failure preserves successful project');
        assert.equal(api.service.get(document.uri)?.state, 'checked', 'A failed workspace folder cannot erase an independent successful observation.');
        assert.equal(api.service.get(emails.uri)?.state, 'checked', 'A failed workspace folder cannot erase a successful project.');
        assert.equal(api.service.get(vscode.Uri.file(path.join(other, 'single.pietto'))), undefined);
      } finally {
        step('restore second workspace folder interpreter');
        await saveFolderSettings(originalSettingsText, originalFolderValue);
        await api.service.whenIdle();
        assert.equal(readFileSync(folderSettingsFile, 'utf8'), originalSettingsText);
      }
      step('project verification complete');
    });
    await stage('project grouped window alias uses its checked pre-window type and authored definition', async () => {
      const project = path.join(workspace, 'project');
      const file = path.join(project, 'models', 'stages.pietto');
      writeFileSync(file, readFileSync(path.join(root, 'examples', 'stages.pietto'), 'utf8'));
      const stages = await vscode.workspace.openTextDocument(file);
      await api.service.whenIdle();
      const cursor = new vscode.Position(18, 16);
      const expectedOccurrence = new vscode.Range(18, 16, 18, 21);
      const expectedDefinition = new vscode.Range(15, 8, 15, 13);
      assert.equal(stages.getText(expectedOccurrence), 'total');
      assert.equal(stages.getText(expectedDefinition), 'total');
      assert.equal(api.service.get(stages.uri)?.state, 'checked', api.service.status);
      assert.equal(api.service.memberships.get(stages.uri.toString()), vscode.Uri.file(project).toString());
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', stages.uri, cursor);
      const hoverText = hovers?.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
      assert.match(hoverText, /Int/);
      assert.match(hoverText.replaceAll('&nbsp;', ' '), /nullability:\s*nullable/);
      assert.ok(hovers?.some(hover => hover.contents.some(content => typeof content !== 'string' && 'isTrusted' in content && content.isTrusted === false)), 'Compiler hover Markdown must remain explicitly untrusted.');
      assert.ok(hovers?.some(hover => hover.range?.isEqual(expectedOccurrence)));
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', stages.uri, cursor);
      assert.ok(definitions?.some(definition => {
        const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
        const range = 'targetUri' in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
        return uri.toString() === stages.uri.toString() && range.isEqual(expectedDefinition);
      }));
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', stages.uri, cursor);
      const fields = completions?.items.filter(item => item.kind === vscode.CompletionItemKind.Field) ?? [];
      const names = fields.map(item => typeof item.label === 'string' ? item.label : item.label.label);
      assert.ok(names.includes('total'));
      for (const excluded of ['id', 'amount', 'metrics.id', 'metrics.amount', 'ranked']) assert.ok(!names.includes(excluded), `Window input must not expose hidden row or current window output field ${excluded}.`);
      assert.ok(api.service.get(stages.uri)?.occurrences.some(item => item.name === 'total' && item.type === 'Int' && item.nullability === 'nullable' && item.range.start.line === 18 && item.range.start.character === 16 && item.definition?.uri === stages.uri.toString()));
    });
    await stage('native connection preview shows safe configured and unbound associations', async () => {
      const configuration = path.join(workspace, 'pietto-connections.json');
      writeFileSync(configuration, JSON.stringify({
        version: 1,
        profiles: [{ id: 'preview', displayName: 'Preview only', provider: 'postgres', host: 'localhost', port: 5432, database: 'analytics' }],
        bindings: [{ module: 'single.pietto', source: 'users', profile: 'preview', tables: [{ declaration: 'emails', schema: 'public', table: 'users' }] }],
      }));
      await api.connections.refresh?.();
      await vscode.commands.executeCommand('pietto.connections.focus');
      const items = await tree(api.connections);
      const text = items.map(item => [label(item), item.description, typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value].join(' ')).join('\n');
      assert.match(text, /configured/i);
      assert.match(text, /unbound/i);
      assert.match(text, /not checked/i);
      assert.match(text, /public\.users/);
      writeFileSync(configuration, JSON.stringify({ version: 1, profiles: [{ id: 'bad', displayName: 'Bad', provider: 'postgres', password: 'DO_NOT_EXPOSE_CREDENTIAL' }], bindings: [] }));
      await api.connections.refresh?.();
      const invalid = await tree(api.connections);
      const invalidText = JSON.stringify(invalid.map(item => ({ label: label(item), description: item.description, tooltip: typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value })));
      assert.match(invalidText, /invalid/i);
      assert.ok(!invalidText.includes('DO_NOT_EXPOSE_CREDENTIAL'));
    });
    await stage('missing interpreter produces actionable unavailable state and recovers', async () => {
      const settings = vscode.workspace.getConfiguration('pietto');
      const original = settings.get<string>('pythonPath');
      await settings.update('pythonPath', path.join(root, '.local', 'missing-python.exe'), vscode.ConfigurationTarget.Global);
      await api.service.whenIdle();
      assert.equal(api.service.observations.size, 0);
      assert.match(api.service.status, /Python|interpreter|start/i);
      await settings.update('pythonPath', original, vscode.ConfigurationTarget.Global);
      await api.service.whenIdle();
      assert.equal(api.service.get(document.uri)?.state, 'checked');
    });
    await stage('real worker malformed nested JSON, incompatible protocol, crash and timeout fail safely', async () => {
      const Constructor = api.service.bridge.constructor as typeof Bridge;
      const python = path.join(root, '.local', 'release-venv', 'Scripts', 'python.exe');
      for (const [name, code, pattern] of [
        ['nested-null', 'import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({"protocol":1,"id":r["id"],"documents":[None],"issues":[]}),flush=True)\n', /malformed|incompatible/],
        ['protocol', 'import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({"protocol":999,"id":r["id"],"documents":[],"issues":[]}),flush=True)\n', /malformed|incompatible/],
        ['crash', 'import sys\nfor line in sys.stdin:\n sys.exit(9)\n', /exited/],
        ['timeout', 'import sys,time\nfor line in sys.stdin:\n time.sleep(10)\n', /timed out/],
      ] as const) {
        const helper = path.join(root, '.local', `host-${name}-worker.py`);
        writeFileSync(helper, code);
        const worker = new Constructor(helper);
        try {
          const pending = worker.request(python, { id: 1, documents: [] }, name === 'timeout' ? 150 : 2000);
          const processId = worker.processId;
          assert.ok(processId);
          await assert.rejects(pending, pattern);
          assert.equal(worker.processId, undefined, `${name}: rejected worker must be cleared`);
          const alive = () => {
            try { process.kill(processId, 0); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
          };
          for (let attempt = 0; attempt < 20 && alive(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(alive(), false, `${name}: owned worker PID ${processId} must terminate`);
        } finally { worker.dispose(); }
      }
    });
    await stage('real untitled buffer has typed symbols and hover without an invented project root or save', async () => {
      const scratch = await vscode.workspace.openTextDocument({ language: 'pietto', content: 'shape Scratch:\n    value: Bool not null\n' });
      await api.service.whenIdle();
      assert.equal(scratch.isUntitled, true);
      assert.equal(scratch.uri.scheme, 'untitled');
      assert.equal(vscode.workspace.getWorkspaceFolder(scratch.uri), undefined);
      assert.equal(api.service.memberships.get(scratch.uri.toString()), undefined);
      const observation = api.service.get(scratch.uri);
      assert.equal(observation?.state, 'checked', api.service.status);
      assert.ok(observation?.symbols.some(symbol => symbol.name === 'Scratch'));
      assert.equal(observation?.symbols.find(symbol => symbol.name === 'Scratch')?.fields?.find(field => field.name === 'value')?.type, 'Bool');
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', scratch.uri, position(scratch, 'value'));
      const text = hovers?.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
      assert.match(text, /Bool/);
      assert.equal(scratch.isUntitled, true);
    });
    await stage('warm analysis measurements stay bounded and owned worker cleans up', async () => {
      warmRequests = [];
      const started = performance.now();
      await api.service.refresh();
      const wallMs = performance.now() - started;
      performanceEvidence.warmRefresh = { wallMs, compilerRequests: warmRequests.length, observedDocuments: api.service.observations.size, explicitProjectRoots: [...api.service.projects.values()].map(root => root.toString()), requests: warmRequests };
      warmRequests = undefined;
      console.log(`Warm refresh wall time: ${wallMs.toFixed(2)} ms`);
      const beforeRequests = compilerRequests;
      const hoverStarted = performance.now();
      for (let count = 0; count < 10; count++) {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position(document, 'email', true));
        assert.ok(hovers?.length);
      }
      performanceEvidence.readOnlyHovers = { count: 10, wallMs: performance.now() - hoverStarted, compilerRequestsBefore: beforeRequests, compilerRequestsAfter: compilerRequests };
      assert.equal(compilerRequests, beforeRequests, 'Repeated hover must consume shared observations without starting compiler requests.');
      assert.ok(api.service.metrics.length <= 20);
      assert.ok(api.service.bridge.processId);
      api.service.dispose();
      assert.equal(api.service.bridge.processId, undefined);
      assert.equal(api.service.observations.size, 0);
    });
    completed = true;
  } finally {
    api.service.bridge.request = request;
    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'artifacts', process.env.PIETTO_HOST_INSTALLED === '1' ? 'vsix-host-results.json' : 'host-results.json'), JSON.stringify({
      vscode: vscode.version,
      extensionPath: extension.extensionPath,
      trusted: vscode.workspace.isTrusted,
      compiler: api.service.compiler,
      stages: results,
      metrics: api.service.metrics,
      performance: performanceEvidence,
      compilerRequestCount: compilerRequests,
      completed,
      failure,
      projectSteps,
      guiInspection: 'NOTRUN: provider and native tree host tests do not inspect screen pixels.',
      restrictedMode: 'NOTRUN in this harness: @vscode/test-electron disables Workspace Trust.',
    }, null, 2));
  }
}
