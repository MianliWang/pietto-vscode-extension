import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {Api, codes, pietto, servers, sleep, span, waitFor} from './common';

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

  // A stand-in interpreter that runs the real one, but first marks each emit-sql run in
  // gated-python.started and holds it until gated-python.go exists.
  const gate = process.platform === 'win32' ? undefined : path.join(root, '.local', 'gated-python');
  const [started, go] = [`${gate}.started`, `${gate}.go`];
  if (!gate) console.log('SKIP whether Pietto runs for a refused project preview, and a project change while it runs: the stand-in interpreter is a POSIX shell script');
  else {
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
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
