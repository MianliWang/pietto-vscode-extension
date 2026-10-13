import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AnalysisService } from '../../src/analysis';

export async function run(): Promise<void> {
  const root = process.env.PIETTO_HOST_ROOT!;
  const workspace = process.env.PIETTO_RESTRICTED_WORKSPACE!;
  assert.equal(vscode.workspace.isTrusted, false, 'This must be the real editor Restricted Mode.');
  const extension = vscode.extensions.getExtension<{ service: AnalysisService; models: vscode.TreeDataProvider<unknown> }>('MianliWang.pietto-vscode-extension');
  assert.ok(extension);
  const api = await extension.activate();
  assert.equal(api.service.bridge.processId, undefined);
  let requests = 0;
  const originalRequest = api.service.bridge.request;
  api.service.bridge.request = async () => { requests++; throw new Error('Restricted Mode attempted a compiler request.'); };
  try {
    const document = await vscode.workspace.openTextDocument(path.join(workspace, 'restricted.pietto'));
    await vscode.window.showTextDocument(document);
    await api.service.whenIdle();
    assert.equal(document.languageId, 'pietto');
    assert.equal(vscode.workspace.isTrusted, false);
    assert.equal(requests, 0);
    assert.equal(api.service.bridge.processId, undefined);
    assert.equal(api.service.observations.size, 0);
    assert.match(api.service.status, /Restricted Mode/);
    assert.ok(!vscode.workspace.getConfiguration('pietto', document.uri).get<string>('pythonPath')?.includes('workspace-selected-python'));
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 0));
    assert.ok(completion?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'shape'));
    const nodes = await api.models.getChildren() ?? [];
    const labels = await Promise.all(nodes.map(async node => (await api.models.getTreeItem(node)).label));
    assert.ok(labels.some(label => typeof label === 'string' && /Restricted Mode/.test(label)));
    console.log('PASS actual Restricted Mode: syntax providers available, workspace interpreter ignored, zero compiler requests/processes.');
    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'artifacts', 'restricted-host-results.json'), JSON.stringify({
      vscode: vscode.version,
      extensionPath: extension.extensionPath,
      trusted: vscode.workspace.isTrusted,
      compilerRequests: requests,
      compilerProcess: api.service.bridge.processId ?? null,
      state: api.service.status,
      completed: true,
    }, null, 2));
  } finally {
    api.service.bridge.request = originalRequest;
    api.service.dispose();
  }
}
