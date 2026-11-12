import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {Api, explains, pietto, servers, sleep} from './common';

export async function run(): Promise<void> {
  const root = process.env.PIETTO_HOST_ROOT!;
  const workspace = process.env.PIETTO_RESTRICTED_WORKSPACE!;
  assert.equal(vscode.workspace.isTrusted, false, 'This must be the real Restricted Mode.');
  const extension = vscode.extensions.getExtension<Api>('MianliWang.pietto-vscode-extension');
  assert.ok(extension);
  const api = await extension.activate();
  if (!servers()) console.log('SKIP the no-process check: it reads /proc, which is Linux-only');
  const file = vscode.Uri.file(path.join(workspace, 'restricted.pietto'));
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('pietto.restart');
  await sleep(5000);
  assert.equal(document.languageId, 'pietto');
  assert.equal(api.client, undefined);
  assert.deepEqual(servers() ?? [], [], 'No pietto lsp process in Restricted Mode.');
  assert.deepEqual(pietto(file), [], 'No diagnostics in Restricted Mode.');
  for (const command of ['pietto.previewPostgresSql', 'pietto.previewSql', 'pietto.previewProjectSql']) await vscode.commands.executeCommand(command);
  await sleep(100);
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString(), 'Restricted Mode does not open SQL preview.');
  assert.deepEqual(servers() ?? [], [], 'Restricted Mode starts no preview process.');
  await vscode.commands.executeCommand('pietto.previewMigration', file);
  await sleep(100);
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString(), 'Restricted Mode does not open a migration preview.');
  assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)), 'Restricted Mode opens no diff.');
  // The project root '.' is selected, so a broken trust gate would run explain on it.
  await vscode.commands.executeCommand('pietto.models.focus');
  await vscode.commands.executeCommand('pietto.refreshModels');
  await sleep(2000);
  assert.deepEqual(await api.models.getChildren(), [{label: 'Trust this workspace to list Pietto models.'}]);
  assert.deepEqual(explains() ?? [], [], 'Restricted Mode runs no explain.');
  assert.deepEqual(api.notices, []);
  assert.ok(!vscode.workspace.getConfiguration('pietto').get<string>('pythonPath')?.includes('workspace-selected-python'), 'The workspace interpreter setting is ignored.');
  const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', file, new vscode.Position(document.lineCount - 1, 0));
  const snippets = completion.items.filter(item => item.kind === vscode.CompletionItemKind.Snippet).map(item => typeof item.label === 'string' ? item.label : item.label.label);
  assert.ok(snippets.includes('shape'), `Snippets stay available: ${snippets.join(', ')}`);
  const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', file);
  // VS Code's indentation folding with folding.offSide: a block's trailing blank lines stay outside its fold.
  assert.deepEqual(folds.map(fold => [fold.start, fold.end]), [[0, 1], [3, 6], [5, 6]], 'Indented blocks fold.');
  console.log('PASS Restricted Mode: Pietto language mode, snippets and folding available; no pietto lsp or explain process, no diagnostics, workspace interpreter ignored.');
  mkdirSync(path.join(root, 'artifacts'), {recursive: true});
  writeFileSync(path.join(root, 'artifacts', 'restricted-host-results.json'), JSON.stringify({
    vscode: vscode.version, extensionPath: extension.extensionPath, trusted: vscode.workspace.isTrusted, client: api.client ?? null,
    serverProcesses: servers() ?? null, diagnostics: pietto(file).length, snippets, folds: folds.map(fold => [fold.start, fold.end]), completed: true,
  }, null, 2));
}
