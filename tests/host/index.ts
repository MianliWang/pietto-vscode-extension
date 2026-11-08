import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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
  const outside = vscode.Uri.file(path.join(workspace, 'loose', 'outside.pietto'));
  const preview = vscode.Uri.file(path.join(workspace, 'loose', 'preview.pietto'));
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
  await step('project root: pietto lsp reports PIE-S2102 for an unknown field in an open module of a two-module project', async () => {
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
