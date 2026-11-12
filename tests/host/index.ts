import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {Node} from '../../src/models';
import {Api, codes, explains, pietto, servers, sleep, span, waitFor} from './common';

export async function run(): Promise<void> {
  const root = process.env.PIETTO_HOST_ROOT!;
  const workspace = process.env.PIETTO_HOST_WORKSPACE!;
  const installedPath = process.env.PIETTO_HOST_INSTALLED_PATH;
  const project = path.join(workspace, 'project');
  const report = vscode.Uri.file(path.join(project, 'models', 'report.pietto'));
  const users = vscode.Uri.file(path.join(project, 'models', 'users.pietto'));
  const facts = vscode.Uri.file(path.join(project, 'models', 'facts.pietto'));
  const outside = vscode.Uri.file(path.join(workspace, 'loose', 'outside.pietto'));
  const preview = vscode.Uri.file(path.join(workspace, 'loose', 'preview.pietto'));
  const mysqlPreview = vscode.Uri.file(path.join(workspace, 'loose', 'preview-mysql.pietto'));
  const items = vscode.Uri.file(path.join(workspace, 'emit', 'models', 'items.pietto'));
  const blocked = vscode.Uri.file(path.join(workspace, 'emit', 'models', 'blocked.pietto'));
  const legacy = vscode.Uri.file(path.join(workspace, 'loose', 'legacy.pietto'));
  const manual = vscode.Uri.file(path.join(workspace, 'loose', 'manual.pietto'));
  const extension = vscode.extensions.getExtension<Api>('MianliWang.pietto-vscode-extension');
  assert.ok(extension, 'The real editor host must discover the Pietto extension.');
  if (installedPath) assert.equal(path.resolve(extension.extensionPath), path.resolve(installedPath), 'The installed VSIX, not the source tree, is under test.');
  const api = await extension.activate();
  const folder = vscode.workspace.workspaceFolders![0];
  const settings = () => vscode.workspace.getConfiguration('pietto', folder.uri);
  const results: {name: string; ms: number; detail?: unknown}[] = [];
  const write = (completed: boolean) => {
    mkdirSync(path.join(root, 'artifacts'), {recursive: true});
    writeFileSync(path.join(root, 'artifacts', installedPath ? 'vsix-host-results.json' : 'host-results.json'), JSON.stringify({
      vscode: vscode.version, extensionPath: extension.extensionPath, server: api.client?.initializeResult?.serverInfo, results, completed,
    }, null, 2));
  };
  const step = async (name: string, action: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      const detail = await action();
      results.push({name, ms: Math.round(performance.now() - started), detail});
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      write(false);
      throw error;
    }
  };
  if (!servers()) console.log('SKIP the process checks (one server, -I, a new pid after restart, none while off): they read /proc, which is Linux-only');
  const interpreter = () => vscode.workspace.getConfiguration('pietto');
  // Exactly one pietto lsp child of this extension host, started with -I.
  const oneServer = () => waitFor('exactly one pietto lsp process', () => {
    const found = servers();
    return found === undefined ? {pid: -1, argv: []} : found.length === 1 && found[0].argv.includes('-I') && found[0];
  });
  // The Pietto quick fixes VS Code offers for a range (default: the whole document), as the
  // lightbulb lists them; the editor's built-in chat actions are left out.
  const fixes = async (uri: vscode.Uri, range?: vscode.Range) => {
    const document = await vscode.workspace.openTextDocument(uri);
    const found = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, range ?? new vscode.Range(0, 0, document.lineCount, 0), vscode.CodeActionKind.QuickFix.value);
    return (found ?? []).filter(action => action.command?.command.startsWith('pietto.'));
  };
  const described = (actions: vscode.CodeAction[]) => actions.map(action => ({title: action.title, kind: action.kind?.value, command: action.command?.command,
    arguments: (action.command?.arguments ?? []).map(String)}));
  const diffs = (original: vscode.Uri) => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === original.toString());

  let error: vscode.Range | undefined;
  await step('project root: pietto lsp reports PIE-S2102 for an unknown field in an open module', async () => {
    await vscode.commands.executeCommand('pietto.selectProject', vscode.Uri.file(project));
    assert.deepEqual(settings().get('projectRoots'), ['project']);
    const document = await vscode.workspace.openTextDocument(report);
    await vscode.window.showTextDocument(document);
    const [diagnostic] = await waitFor('PIE-S2102 alone in report.pietto', () => {
      const found = pietto(report);
      return found.length === 1 && found[0].code === 'PIE-S2102' && found;
    });
    assert.equal(diagnostic.message, 'Unknown field: emial');
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    assert.deepEqual(span(diagnostic.range), [7, 8, 7, 13]);
    assert.equal(document.getText(diagnostic.range), 'emial');
    error = diagnostic.range;
    const server = await oneServer();
    return {code: diagnostic.code, message: diagnostic.message, range: span(diagnostic.range), severity: 'Error', serverPid: server.pid, serverArgv: server.argv};
  });

  await step('an unsaved edit that fixes the field clears the diagnostic; the file on disk is unchanged', async () => {
    const disk = readFileSync(report.fsPath, 'utf8');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(report, error!, 'email');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor('no diagnostics in report.pietto', () => pietto(report).length === 0);
    assert.equal(readFileSync(report.fsPath, 'utf8'), disk);
    assert.equal(vscode.workspace.textDocuments.find(document => document.uri.toString() === report.toString())?.isDirty, true);
  });

  await step('real LSP providers return hover, exact cross-module definitions and ordered document symbols', async () => {
    const document = await vscode.workspace.openTextDocument(facts);
    await vscode.window.showTextDocument(document);
    const text = document.getText();
    const typePosition = document.positionAt(text.indexOf('owner: User') + 'owner: '.length);
    const fromPosition = document.positionAt(text.indexOf('from users') + 'from '.length);
    const hovers = await waitFor<vscode.Hover[]>('a real User hover', async () => {
      const found = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', facts, typePosition);
      return found?.length ? found : false;
    });
    assert.equal(hovers.length, 1);
    assert.ok(hovers[0].range);
    assert.equal(document.getText(hovers[0].range), 'User');
    const hoverText = hovers[0].contents.map(item => typeof item === 'string' ? item : item.value).join('\n');
    assert.equal(hoverText.replaceAll('&nbsp;', ' '), 'shape User');
    const targets = [];
    for (const [position, expected] of [[typePosition, [0, 0, 2, 22]], [fromPosition, [4, 0, 4, 51]]] as const) {
      const locations = await waitFor<vscode.Location[]>('an exact definition target', async () => {
        const found = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', facts, position);
        return found?.length ? found : false;
      });
      assert.equal(locations.length, 1);
      assert.equal(locations[0].uri.toString(), users.toString());
      assert.deepEqual(span(locations[0].range), expected);
      targets.push({uri: locations[0].uri.toString(), range: span(locations[0].range)});
    }
    const symbols = await waitFor<vscode.DocumentSymbol[]>('ordered document symbols', async () => {
      const found = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', facts);
      return found?.length ? found : false;
    });
    assert.deepEqual(symbols.map(item => item.name), ['Audit', 'audit_users']);
    assert.equal(symbols[0].kind, vscode.SymbolKind.Class);
    assert.deepEqual(symbols.map(item => item.detail), ['shape Audit', 'query audit_users']);
    assert.deepEqual(pietto(facts), []);
    return {hover: {text: hoverText.replaceAll('&nbsp;', ' '), range: span(hovers[0].range)}, targets, symbols: symbols.map(item => ({name: item.name, kind: item.kind, range: span(item.range)}))};
  });

  await step('a document-symbol request sent right after an edit answers once with the edited outline', async () => {
    const document = await vscode.workspace.openTextDocument(facts);
    await vscode.window.showTextDocument(document);
    const end = document.positionAt(document.getText().length);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(facts, end, '\nquery audit_ids:\n    from users\n    select:\n        id\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    // One request and no retry: the server answers it after the edit's analysis.
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', facts);
    assert.deepEqual(symbols?.map(item => item.name), ['Audit', 'audit_users', 'audit_ids']);
    const undo = new vscode.WorkspaceEdit();
    undo.delete(facts, new vscode.Range(end, document.positionAt(document.getText().length)));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    await waitFor('the original outline after the undo', async () => {
      const found = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', facts);
      return found?.length === 2 ? found : false;
    });
    return {names: symbols.map(item => item.name)};
  });

  await step('a pietto.toml edited on disk under the root restarts pietto lsp, which reads the new selection', async () => {
    const toml = path.join(project, 'pietto.toml');
    const original = readFileSync(toml, 'utf8');
    const document = await vscode.workspace.openTextDocument(facts);
    await vscode.window.showTextDocument(document);
    const typePosition = document.positionAt(document.getText().indexOf('owner: User') + 'owner: '.length);
    const definitions = async () => (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', facts, typePosition)) ?? [];
    const first = await oneServer();
    writeFileSync(toml, original.replace('include = ["models/*.pietto"]', 'include = ["models/users.pietto"]'));
    await waitFor('report.pietto checked as a single file once the root leaves it out', () => codes(report).join() === 'PIE-S2301,PIE-S2708');
    const second = await oneServer();
    assert.ok(first.pid === -1 || second.pid !== first.pid, 'A new pietto lsp process read the edited pietto.toml.');
    writeFileSync(toml, original);
    // A project-only fact, not an empty diagnostic set, shows that the restored root was read.
    await waitFor('a cross-module definition from facts.pietto again', async () => {
      const found = await definitions();
      return found.length === 1 && found[0].uri.toString() === users.toString();
    });
    assert.deepEqual(pietto(report), []);
    const third = await oneServer();
    assert.ok(third.pid === -1 || third.pid !== second.pid, 'Restoring pietto.toml started another pietto lsp process.');
    return {servers: [first.pid, second.pid, third.pid]};
  });

  await step('a file outside the project root is checked as a single file (PIE-S2708 at its import)', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outside));
    await waitFor('single-file diagnostics in outside.pietto', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    const [relation, imported] = [...pietto(outside)].sort((a, b) => String(a.code).localeCompare(String(b.code)));
    assert.equal(imported.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(imported.message, 'Module import is resolved only by check --project ROOT, in a schema_version = 2 project');
    assert.deepEqual(span(imported.range), [0, 0, 1, 17]);
    assert.equal(relation.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(relation.message, 'Unknown relation: users');
    assert.deepEqual(span(relation.range), [4, 4, 4, 14]);
    return pietto(outside).map(item => ({code: item.code, message: item.message, range: span(item.range), severity: item.severity}));
  });

  await step('the single-file PIE-S2708 Warning offers "Select project root"; PIE-S2301 offers no quick fix', async () => {
    const [imported, relation] = [...pietto(outside)].sort((a, b) => String(b.code).localeCompare(String(a.code)));
    assert.equal(imported.code, 'PIE-S2708');
    const actions = described(await fixes(outside, imported.range));
    assert.deepEqual(actions, [{title: 'Select project root', kind: 'quickfix', command: 'pietto.selectProject', arguments: []}]);
    assert.deepEqual(described(await fixes(outside)), actions, 'One action for the whole file.');
    assert.equal(relation.code, 'PIE-S2301');
    assert.deepEqual(await fixes(outside, relation.range), [], 'PIE-S2301 alone gets no quick fix.');
    return actions;
  });

  await step('two project roots selecting one file: the editor-only message, without a PIE code, at the file start', async () => {
    await settings().update('projectRoots', ['project', 'project/models'], vscode.ConfigurationTarget.WorkspaceFolder);
    const message = `This file belongs to two project roots: ${project} and ${path.join(project, 'models')}. Keep one of them in projectRoots.`;
    for (const uri of [report, users]) {
      const [item] = await waitFor(`the two-roots message in ${path.basename(uri.fsPath)}`, () => {
        const found = pietto(uri);
        return found.length === 1 && found[0].message === message && found;
      });
      assert.equal(item.code, undefined);
      assert.equal(item.severity, vscode.DiagnosticSeverity.Error);
      assert.deepEqual(span(item.range), [0, 0, 0, 0]);
    }
    await waitFor('outside.pietto still checked as a single file', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    await oneServer();
    assert.deepEqual(await fixes(report), [], 'An editor-only message has no code, so it gets no quick fix.');
    return {message, files: ['project/models/report.pietto (open)', 'project/models/users.pietto (not open)']};
  });

  await step('"Use Single File Mode" clears the roots: the module is checked as a single file and project diagnostics go', async () => {
    await vscode.commands.executeCommand('pietto.clearProject');
    assert.deepEqual(settings().get('projectRoots'), []);
    await waitFor('single-file diagnostics in report.pietto', () => codes(report).join() === 'PIE-S2301,PIE-S2708');
    await waitFor('no diagnostics left on the unopened module', () => pietto(users).length === 0);
    await oneServer();
  });

  await step('an untitled Pietto buffer is checked as a single file', async () => {
    const document = await vscode.workspace.openTextDocument({language: 'pietto', content: 'query q:\n    from nowhere\n    select:\n        id\n'});
    await vscode.window.showTextDocument(document);
    const [item] = await waitFor('PIE-S2301 in the untitled buffer', () => {
      const found = pietto(document.uri);
      return found.length === 1 && found;
    });
    assert.equal(item.code, 'PIE-S2301');
    assert.equal(item.message, 'Unknown relation: nowhere');
    assert.deepEqual(span(item.range), [1, 4, 1, 16]);
  });

  await step('Preview PostgreSQL SQL reads a saved single file and opens only its emitted SQL', async () => {
    const document = await vscode.workspace.openTextDocument(preview);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('pietto.previewPostgresSql');
    const result = await waitFor('a PostgreSQL SQL preview document', () => {
      const current = vscode.window.activeTextEditor?.document;
      return current?.uri.scheme === 'pietto-sql-preview' && current;
    });
    assert.match(result.getText(), /^SELECT\b/);
    assert.doesNotMatch(result.getText(), /PIE-/);
    assert.equal(readFileSync(preview.fsPath, 'utf8'), document.getText(), 'Preview did not write the source file.');
    return {scheme: result.uri.scheme, preview: result.getText()};
  });

  await step('Preview PostgreSQL SQL refuses a dirty document without replacing it', async () => {
    const document = await vscode.workspace.openTextDocument(preview);
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(preview, new vscode.Position(0, 0), '# unsaved\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await vscode.commands.executeCommand('pietto.previewPostgresSql');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), preview.toString());
    assert.equal(document.isDirty, true);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await step('PIE-P1000 offers one migration preview: a diff of the saved file and its pietto migrate output, nothing written', async () => {
    const document = await vscode.workspace.openTextDocument(legacy);
    await vscode.window.showTextDocument(document);
    await waitFor('PIE-P1000 at both retired spellings of legacy.pietto', () => codes(legacy).join() === 'PIE-P1000,PIE-P1000');
    const actions = await fixes(legacy);
    // Two PIE-P1000 diagnostics, one action.
    assert.deepEqual(described(actions), [{title: 'Preview migration (pietto migrate)', kind: 'quickfix', command: 'pietto.previewMigration', arguments: [legacy.toString()]}]);
    const disk = readFileSync(legacy.fsPath, 'utf8');
    await vscode.commands.executeCommand(actions[0].command!.command, ...actions[0].command!.arguments!);
    const diff = await waitFor('the migration diff editor', () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input;
    });
    assert.equal(diff.original.toString(), legacy.toString());
    assert.equal(diff.modified.scheme, 'pietto-migration-preview');
    const migrated = await vscode.workspace.openTextDocument(diff.modified);
    assert.equal(migrated.getText(), 'shape User:\n    id: Int\n    email: Text | None\n\nsource users: User = postgres.table("public.users")\n');
    assert.equal(readFileSync(legacy.fsPath, 'utf8'), disk, 'The migration preview did not write the source file.');
    assert.equal(document.isDirty, false);
    assert.equal(migrated.isDirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    return {original: diff.original.toString(), modified: diff.modified.toString(), migrated: migrated.getText()};
  });

  await step('a migration that pietto migrate refuses, or of a dirty file, opens no diff and writes nothing', async () => {
    const document = await vscode.workspace.openTextDocument(manual);
    await vscode.window.showTextDocument(document);
    await waitFor('PIE-P1000 at the retired header line of manual.pietto', () => codes(manual).join() === 'PIE-P1000');
    const [action] = await fixes(manual);
    assert.equal(action?.command?.command, 'pietto.previewMigration');
    await vscode.commands.executeCommand(action.command!.command, ...action.command!.arguments!);
    assert.deepEqual(diffs(manual), [], 'A PIE-P1011 refusal opens no diff.');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), manual.toString());
    assert.equal(readFileSync(manual.fsPath, 'utf8'), 'mode strict\nshape Legacy:\n    id: Int\n');
    const dirty = await vscode.workspace.openTextDocument(legacy);
    await vscode.window.showTextDocument(dirty);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(legacy, new vscode.Position(0, 0), '# unsaved\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await vscode.commands.executeCommand('pietto.previewMigration', legacy);
    assert.deepEqual(diffs(legacy), [], 'An unsaved buffer is not migrated.');
    assert.equal(dirty.isDirty, true);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.equal(readFileSync(legacy.fsPath, 'utf8').startsWith('shape User:'), true);
  });

  // The active editor shows the preview document with this name.
  const previewNamed = (name: string) => waitFor(`the preview ${name}`, () => {
    const current = vscode.window.activeTextEditor?.document;
    return current?.uri.scheme === 'pietto-sql-preview' && current.uri.path === `/${name}` && current;
  });

  await step('Preview SQL follows pietto.sqlDialect: a MySQL file opens its MySQL SQL, and a dialect argument overrides the setting', async () => {
    await settings().update('sqlDialect', 'mysql', vscode.ConfigurationTarget.WorkspaceFolder);
    const document = await vscode.workspace.openTextDocument(mysqlPreview);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('pietto.previewSql');
    const mysql = await previewNamed('preview-mysql.pietto.1.mysql.sql');
    assert.equal(mysql.getText(), 'SELECT\n    `id` AS `id`\nFROM `fixture`.`items`');
    assert.equal(mysql.languageId, 'sql');
    assert.equal(readFileSync(mysqlPreview.fsPath, 'utf8'), document.getText(), 'Preview did not write the source file.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(preview));
    await vscode.commands.executeCommand('pietto.previewSql', {dialect: 'postgres'});
    const postgres = await previewNamed('preview.pietto.1.postgres.sql');
    assert.equal(postgres.getText(), 'SELECT\n    "id" AS "id"\nFROM "public"."items"');
    await settings().update('sqlDialect', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    return {mysql: mysql.getText(), postgres: postgres.getText()};
  });

  await step('Preview Project SQL offers the batch items of a module in order and opens the chosen VERIFIED SQL', async () => {
    await settings().update('projectRoots', ['emit'], vscode.ConfigurationTarget.WorkspaceFolder);
    const document = await vscode.workspace.openTextDocument(items);
    await vscode.window.showTextDocument(document);
    // The module has the table active_items (VERIFIED), then the query small_items (BLOCKED);
    // once the quick pick is up, accepting it takes the first.
    const command = vscode.commands.executeCommand('pietto.previewProjectSql', {emissionContract: 'contract.json'});
    const sql = await waitFor('the first item of the project SQL quick pick', async () => {
      const current = vscode.window.activeTextEditor?.document;
      if (current?.uri.scheme === 'pietto-sql-preview' && current.uri.path === '/items.pietto.table.active_items.postgres.sql') return current;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return false;
    }, 60_000);
    await command;
    assert.equal(sql.getText(), 'SELECT "s0"."item_id" AS "id", "s0"."item_label" AS "label" FROM "fixture"."items" AS "s0"');
    assert.equal(sql.languageId, 'sql');
    assert.equal(readFileSync(items.fsPath, 'utf8'), document.getText(), 'Preview did not write the source file.');
    return {path: sql.uri.path, sql: sql.getText()};
  });

  await step('Preview Project SQL shows a BLOCKED document as a report of its blockers', async () => {
    await settings().update('emissionContract', 'contract.json', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(blocked));
    await vscode.commands.executeCommand('pietto.previewProjectSql');
    const report = await previewNamed('blocked.pietto.query.large_items.postgres.blocked.txt');
    assert.equal(report.languageId, 'plaintext');
    assert.equal(report.getText(), 'query large_items in models/blocked.pietto, PostgreSQL\npietto.sql-emission.v1 BLOCKED\n'
      + 'blocker PIE-B1004 MISSING_EVIDENCE: identifier_case_declaration_missing\n  hint: add {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"\n');
    return {report: report.getText()};
  });

  // The Pietto Models view of the emit root, through the provider that the view shows.
  const emitRoot = {root: path.join(workspace, 'emit')};
  const modelNodes = async () => (await api.models.getChildren(emitRoot) ?? []) as Node[];
  const listed = (what: string, check: (nodes: Node[]) => boolean) => waitFor(what, async () => {
    const nodes = await modelNodes();
    return check(nodes) && nodes;
  }, 60_000);
  const id = {label: 'id: Int', description: 'non_null'};
  const emitRelations = (large: Node[]) => [
    {label: 'table active_items', description: 'models/items.pietto', children: [id, {label: 'label: Text', description: 'non_null'}]},
    {label: 'query small_items', description: 'models/items.pietto', children: [id]},
    {label: 'query large_items', description: 'models/blocked.pietto', children: large},
  ];
  const marked = async () => (await api.models.getTreeItem(emitRoot)).description;
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

  await step('Pietto Models lists every table and query of a root with its columns, in project order', async () => {
    await vscode.commands.executeCommand('pietto.models.focus');
    assert.deepEqual(await api.models.getChildren(), [emitRoot]);
    const nodes = await listed('the relations of the emit root', found => found.length === 3);
    assert.deepEqual(nodes, emitRelations([id]));
    assert.equal(await marked(), undefined);
    return nodes;
  });

  await step('an unsaved module marks its root as showing the saved files; saving it lists the new column', async () => {
    const document = await vscode.workspace.openTextDocument(blocked);
    await vscode.window.showTextDocument(document);
    const disk = document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(blocked, document.positionAt(disk.length), '        doubled = id * 2\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor('the saved-files mark on the root', async () => await marked() === 'shows the saved files');
    assert.deepEqual(await modelNodes(), emitRelations([id]));
    const saved = performance.now();
    assert.equal(await document.save(), true);
    const nodes = await listed('the saved column', found => found[2]?.children?.length === 2);
    const ms = Math.round(performance.now() - saved);
    assert.deepEqual(nodes, emitRelations([id, {label: 'doubled: Int', description: 'unknown'}]));
    assert.equal(await marked(), undefined);
    const undo = new vscode.WorkspaceEdit();
    undo.delete(blocked, new vscode.Range(document.positionAt(disk.length), document.positionAt(document.getText().length)));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    assert.equal(await document.save(), true);
    assert.equal(readFileSync(blocked.fsPath, 'utf8'), disk);
    await listed('the original columns again', found => found[2]?.children?.length === 1);
    return {saveToColumnMs: ms};
  });

  if (process.platform === 'win32' || !servers()) console.log('SKIP one explain per root and a hidden view: they hold a POSIX stand-in interpreter and read /proc');
  else {
    await step('a root runs one explain at a time: a refresh stops the running one, and the next starts after it exits', async () => {
      // A stand-in interpreter that holds each explain run until held-explain.go exists and,
      // stopped, exits only a second later, so a next run that does not wait would overlap it.
      const held = path.join(root, '.local', 'held-explain');
      const release = `${held}.go`;
      const real = interpreter().get<string>('pythonPath', 'python');
      writeFileSync(held, `#!/bin/sh\ntrap "sleep 1; exit 143" TERM\nfor arg; do if [ "$arg" = explain ]; then while [ ! -e ${quote(release)} ]; do sleep 0.05; done; fi; done\nexec ${quote(real)} "$@"\n`, {mode: 0o755});
      rmSync(release, {force: true});
      await interpreter().update('pythonPath', held, vscode.ConfigurationTarget.Workspace);
      const first = await waitFor('one held explain', () => { const found = explains()!; return found.length === 1 && found[0]; }, 60_000);
      await vscode.commands.executeCommand('pietto.refreshModels');
      await vscode.commands.executeCommand('pietto.refreshModels');
      let most = 0;
      for (const end = Date.now() + 2000; Date.now() < end; await sleep(10)) most = Math.max(most, explains()!.length);
      const last = await waitFor('the replacing held explain', () => { const found = explains()!; return found.length === 1 && found[0].pid !== first.pid && found[0]; }, 60_000);
      assert.equal(most, 1, 'Never two explain processes for one root.');
      writeFileSync(release, '');
      await waitFor('the released explain to finish', () => explains()!.length === 0, 60_000);
      assert.deepEqual(await modelNodes(), emitRelations([id]));
      await interpreter().update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
      return {first: first.pid, last: last.pid, most};
    });

    await step('a hidden Pietto Models view runs no explain when a module of its root is saved', async () => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await waitFor('no explain process', () => explains()!.length === 0, 60_000);
      const document = await vscode.workspace.openTextDocument(blocked);
      const disk = document.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(blocked, new vscode.Position(0, 0), '# saved while the view is hidden\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(await document.save(), true);
      let most = 0;
      for (const end = Date.now() + 2000; Date.now() < end; await sleep(10)) most = Math.max(most, explains()!.length);
      assert.equal(most, 0, 'No explain while the view is hidden.');
      const undo = new vscode.WorkspaceEdit();
      undo.delete(blocked, new vscode.Range(0, 0, 1, 0));
      assert.equal(await vscode.workspace.applyEdit(undo), true);
      assert.equal(await document.save(), true);
      assert.equal(readFileSync(blocked.fsPath, 'utf8'), disk);
    });
  }

  // The target diagnostics of a file, as [message, code, severity, source, range].
  const targets = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(item => item.source?.startsWith('pietto emit-sql'))
    .map(item => [item.message, String(item.code), item.severity, item.source, span(item.range)]);
  // An edit at `at`, then a save, which is what starts emit-sql.
  const saveWith = async (uri: vscode.Uri, at: (document: vscode.TextDocument) => vscode.Position, text: string) => {
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, at(document), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await document.save(), true);
    return document;
  };
  const evidence = (name: string) => [`query ${name}: MISSING_EVIDENCE: identifier_case_declaration_missing\nadd {"key":"identifier_case","scope":"statement","value":"quoted_exact"} to "environment"`,
    'PIE-B1004', vscode.DiagnosticSeverity.Warning, 'pietto emit-sql (postgres)', [0, 0, 0, 0]];

  await step('target diagnostics are off by default; turned on, a save shows the root\'s emit-sql refusals as Warnings, and an edit clears them', async () => {
    assert.equal(settings().get('targetDiagnostics'), false);
    const document = await saveWith(blocked, () => new vscode.Position(0, 0), '# saved\n');
    await sleep(2000);
    assert.deepEqual([...targets(items), ...targets(blocked)], [], 'Off by default, a save shows nothing.');
    await settings().update('targetDiagnostics', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await saveWith(blocked, () => new vscode.Position(0, 0), '# saved\n');
    // Both queries miss evidence, which has no location: each is at the start of its module.
    const shown = () => targets(items).length === 1 && targets(blocked).length === 1 && [...targets(items), ...targets(blocked)];
    assert.deepEqual(await waitFor('the target diagnostics of both modules', shown, 60_000), [evidence('small_items'), evidence('large_items')]);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(items, new vscode.Position(0, 0), '# unsaved\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor('no target diagnostics in the root after an edit', () => !targets(items).length && !targets(blocked).length);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(items));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    const undo = new vscode.WorkspaceEdit();
    undo.delete(blocked, new vscode.Range(0, 0, 2, 0));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    assert.equal(await document.save(), true);
    assert.deepEqual(await waitFor('the target diagnostics again after a save', shown, 60_000), [evidence('small_items'), evidence('large_items')]);
    return {items: targets(items), blocked: targets(blocked)};
  });

  await step('a target diagnostic of a file outside every root has its location; turned off, none remain', async () => {
    const document = await saveWith(mysqlPreview, document => document.positionAt(document.getText().length), '\n');
    const found = await waitFor('the PIE-B1000 refusal of a MySQL source', () => targets(mysqlPreview).length && targets(mysqlPreview), 60_000);
    assert.deepEqual(found, [['PostgreSQL SQL emission is not implemented for RelationIR: item_ids. PostgreSQL relation emission requires postgres.table(Text)',
      'PIE-B1000', vscode.DiagnosticSeverity.Warning, 'pietto emit-sql (postgres)', [5, 0, 8, 10]]]);
    const undo = new vscode.WorkspaceEdit();
    undo.delete(mysqlPreview, new vscode.Range(document.lineCount - 2, 0, document.lineCount - 1, 0));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    assert.equal(await document.save(), true);
    await settings().update('targetDiagnostics', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await waitFor('no target diagnostics once turned off', () => !targets(mysqlPreview).length && !targets(items).length && !targets(blocked).length);
    return {found};
  });

  // A stand-in interpreter that runs the real one, but first marks each emit-sql run in
  // gated-python.started and holds it until gated-python.go exists.
  const gate = process.platform === 'win32' ? undefined : path.join(root, '.local', 'gated-python');
  const [started, go] = [`${gate}.started`, `${gate}.go`];
  if (!gate) console.log('SKIP whether Pietto runs for a refused project preview, and a project change while it runs: the stand-in interpreter is a POSIX shell script');
  else {
    writeFileSync(gate, `#!/bin/sh\nfor arg; do if [ "$arg" = emit-sql ]; then : > ${quote(started)}; while [ ! -e ${quote(go)} ]; do sleep 0.05; done; fi; done\n`
      + `exec ${quote(interpreter().get<string>('pythonPath', 'python'))} "$@"\n`, {mode: 0o755});
    rmSync(started, {force: true});
    writeFileSync(go, '');
    await interpreter().update('pythonPath', gate, vscode.ConfigurationTarget.Workspace);
  }

  await step('Preview Project SQL refuses, without running Pietto, while another file of the project root has unsaved changes', async () => {
    const other = await vscode.workspace.openTextDocument(items);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(items, new vscode.Position(0, 0), '# unsaved\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(blocked));
    await vscode.commands.executeCommand('pietto.previewProjectSql');
    if (gate) assert.equal(existsSync(started), false, 'Pietto did not run.');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), blocked.toString());
    assert.equal(other.isDirty, true);
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  if (gate) await step('Preview Project SQL opens nothing when another file of the project root is changed and saved while Pietto runs', async () => {
    rmSync(go);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(items));
    let done = false;
    const command = Promise.resolve(vscode.commands.executeCommand('pietto.previewProjectSql')).finally(() => { done = true; });
    await waitFor('Pietto to start', () => existsSync(started));
    // Saved again, the root has no unsaved file and the active document is unchanged; only the
    // change itself makes the result stale.
    const changed = await vscode.workspace.openTextDocument(blocked);
    const disk = changed.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(blocked, new vscode.Position(0, 0), '# changed while Pietto runs\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await changed.save(), true);
    writeFileSync(go, '');
    // A result that is not stale offers the module's two items, and accepting takes the first.
    await waitFor('the stale project preview to finish', async () => {
      if (done) return true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return false;
    }, 60_000);
    await command;
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), items.toString(), 'A stale project result opens no preview.');
    const undo = new vscode.WorkspaceEdit();
    undo.delete(blocked, new vscode.Range(0, 0, 1, 0));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    assert.equal(await changed.save(), true);
    assert.equal(readFileSync(blocked.fsPath, 'utf8'), disk);
  });
  for (const name of ['projectRoots', 'emissionContract']) await settings().update(name, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  if (gate) {
    // The next steps count the messages of their own restarts, so this one finishes first.
    const gated = api.client;
    await interpreter().update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor('a server from the real interpreter', () => api.client !== gated && api.client?.initializeResult, 60_000);
  }

  await step('an interpreter without pietto: one actionable message, no server process, no restart loop', async () => {
    const before = api.notices.length;
    const launcher = vscode.workspace.getConfiguration('pietto').get<string[]>('pythonArguments', []);
    // -S leaves site-packages off sys.path: the same interpreter, without pietto.
    await vscode.workspace.getConfiguration('pietto').update('pythonArguments', [...launcher, '-S'], vscode.ConfigurationTarget.Workspace);
    const notice = await waitFor('the missing-pietto message', () => api.notices.length > before && api.notices[before], 60_000);
    assert.match(notice, /could not run "pietto lsp" \(ModuleNotFoundError: No module named 'pietto'\)/);
    assert.match(notice, /Install pietto 0\.1\.10 or later/);
    assert.match(notice, /"Pietto: Restart Language Server"/);
    await sleep(3000);
    assert.equal(api.notices.length, before + 1, 'Exactly one message.');
    assert.equal(api.client, undefined);
    assert.deepEqual(servers() ?? [], []);
    assert.deepEqual(pietto(outside), [], 'No stale diagnostics while the server is off.');
    return {notice};
  });

  await step('restoring the interpreter brings diagnostics back; Restart Language Server replaces the process', async () => {
    await vscode.workspace.getConfiguration('pietto').update('pythonArguments', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor('diagnostics again in outside.pietto', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    const first = await oneServer();
    await vscode.commands.executeCommand('pietto.restart');
    const second = await oneServer();
    assert.ok(first.pid === -1 || second.pid !== first.pid, 'Restart starts a new pietto lsp process.');
    await waitFor('diagnostics after the restart', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    return {before: first.pid, after: second.pid, server: api.client?.initializeResult?.serverInfo};
  });

  await step('an empty pietto.pythonPath: one actionable message instead of a silent failure, then recovery', async () => {
    const before = api.notices.length;
    await interpreter().update('pythonPath', '', vscode.ConfigurationTarget.Workspace);
    const notice = await waitFor('the empty-path message', () => api.notices.length > before && api.notices[before], 60_000);
    assert.match(notice, /^Pietto diagnostics are off: "" could not run "pietto lsp" \(The argument 'file' cannot be empty/);
    assert.equal(api.client, undefined);
    assert.deepEqual(servers() ?? [], []);
    await interpreter().update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor('diagnostics again in outside.pietto', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    await oneServer();
    return {notice};
  });

  if (process.platform === 'win32') console.log('SKIP a server that never answers: the stand-in is a POSIX shell script');
  else await step('a server that passes the probe but never answers: one message after 30 s, and a settings change still replaces it', async () => {
    // Exits 0 for the --help probe, then reads the requests without ever answering.
    const silent = path.join(root, '.local', 'silent-python');
    writeFileSync(silent, '#!/bin/sh\ncase "$*" in *--help*) exit 0 ;; esac\nwhile read -r line; do :; done\n', {mode: 0o755});
    const before = api.notices.length;
    await interpreter().update('pythonPath', silent, vscode.ConfigurationTarget.Workspace);
    const notice = await waitFor('the no-answer message', () => api.notices.length > before && api.notices[before], 90_000);
    assert.match(notice, /"pietto lsp" from ".*silent-python" has not answered within 30 seconds/);
    assert.ok(servers()?.some(server => server.argv[1] === silent) ?? true, 'The silent server is still running.');
    await interpreter().update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor('diagnostics again in outside.pietto', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    const server = await oneServer();
    assert.notEqual(server.argv[1], silent, 'The restart replaced the silent server.');
    return {notice};
  });

  const oldPython = process.env.PIETTO_TEST_OLD_PYTHON;
  if (!oldPython) console.log('SKIP a pietto without the lsp subcommand: set PIETTO_TEST_OLD_PYTHON');
  else await step('a pietto without the lsp subcommand: one actionable message naming it, then recovery', async () => {
    const before = api.notices.length;
    await vscode.workspace.getConfiguration('pietto').update('pythonPath', oldPython, vscode.ConfigurationTarget.Workspace);
    const notice = await waitFor('the old-pietto message', () => api.notices.length > before && api.notices[before], 60_000);
    assert.match(notice, /could not run "pietto lsp" \(pietto: error: argument command: invalid choice: 'lsp'/);
    assert.match(notice, /Install pietto 0\.1\.10 or later/);
    await sleep(3000);
    assert.equal(api.notices.length, before + 1, 'Exactly one message.');
    assert.equal(api.client, undefined);
    assert.deepEqual(servers() ?? [], []);
    await vscode.workspace.getConfiguration('pietto').update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor('diagnostics again in outside.pietto', () => codes(outside).join() === 'PIE-S2301,PIE-S2708');
    await oneServer();
    return {notice};
  });

  for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  write(true);
}
