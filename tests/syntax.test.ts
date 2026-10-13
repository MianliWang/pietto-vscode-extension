import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Registry, parseRawGrammar, INITIAL, IToken } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

async function grammar() {
  const bytes = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await loadWASM(new Uint8Array(bytes).buffer);
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new OnigScanner(patterns),
      createOnigString: text => new OnigString(text),
    }),
    loadGrammar: async scope => scope === 'source.pietto'
      ? parseRawGrammar(readFileSync(path.join(process.cwd(), 'syntaxes/pietto.tmLanguage.json'), 'utf8'), 'pietto.tmLanguage.json')
      : null,
  });
  const loaded = await registry.loadGrammar('source.pietto');
  assert.ok(loaded);
  return loaded;
}

function scopes(tokens: IToken[], line: string, text: string) {
  const start = line.indexOf(text);
  assert.notEqual(start, -1);
  return tokens.find(token => token.startIndex <= start && token.endIndex > start)?.scopes ?? [];
}

test('real TextMate tokenization respects Pietto strings, comments and case', async () => {
  const loaded = await grammar();
  const line = 'source users: User is postgres.table("select \\" # from") # query';
  const tokens = loaded.tokenizeLine(line, INITIAL).tokens;
  assert.ok(scopes(tokens, line, 'source').includes('keyword.declaration.pietto'));
  assert.ok(scopes(tokens, line, 'users').includes('entity.name.type.pietto'));
  assert.ok(scopes(tokens, line, 'select').includes('string.quoted.double.pietto'));
  assert.ok(scopes(tokens, line, '\\"').includes('constant.character.escape.pietto'));
  assert.ok(scopes(tokens, line, '# from').includes('string.quoted.double.pietto'));
  assert.ok(scopes(tokens, line, '# query').includes('comment.line.number-sign.pietto'));
  const single = "    note = 'where \\' select'";
  assert.ok(scopes(loaded.tokenizeLine(single, INITIAL).tokens, single, 'where').includes('string.quoted.single.pietto'));
  const upper = 'QUERY result:';
  assert.ok(!scopes(loaded.tokenizeLine(upper, INITIAL).tokens, upper, 'QUERY').some(scope => scope.startsWith('keyword')));
});

test('contextual keywords remain names in declarations, fields, paths and aliases', async () => {
  const loaded = await grammar();
  for (const [line, name, scope] of [
    ['shape order:', 'order', 'entity.name.type.pietto'],
    ['    group: Int not null', 'group', 'variable.other.member.pietto'],
    ['source import: order is postgres.table("public.records")', 'import', 'entity.name.type.pietto'],
    ['    from order', 'order', 'variable.other.pietto'],
    ['        rows = source.order', 'rows', 'variable.other.pietto'],
    ['        source.order', '.order', 'variable.other.member.pietto'],
  ]) {
    const tokenScopes = scopes(loaded.tokenizeLine(line, INITIAL).tokens, line, name);
    assert.ok(tokenScopes.includes(scope), `${line}: ${name}: ${tokenScopes.join(', ')}`);
    assert.ok(!tokenScopes.some(value => value.startsWith('keyword')), `${name} must stay an identifier`);
  }
  for (const line of ['        asc', '        desc', '        rows', '        order', '        first', '        ignore']) {
    assert.ok(!loaded.tokenizeLine(line, INITIAL).tokens.some(token => token.scopes.some(scope => scope.startsWith('keyword'))), line);
  }
  const block = '    order by:';
  assert.ok(scopes(loaded.tokenizeLine(block, INITIAL).tokens, block, 'order').includes('keyword.control.pietto'));
  const field = '    amount: Decimal nullable';
  const tokens = loaded.tokenizeLine(field, INITIAL).tokens;
  assert.ok(scopes(tokens, field, 'Decimal').includes('support.type.pietto'));
  assert.ok(scopes(tokens, field, 'nullable').includes('keyword.operator.word.pietto'));
  assert.ok(scopes(loaded.tokenizeLine('    limit 10', INITIAL).tokens, '    limit 10', '10').includes('constant.numeric.pietto'));
});

test('editing configuration follows colon/indent grammar and useful snippets have no brace blocks', () => {
  const configuration = JSON.parse(readFileSync('language-configuration.json', 'utf8'));
  assert.equal(configuration.comments.lineComment, '#');
  assert.deepEqual(configuration.brackets, [['(', ')']]);
  assert.equal(configuration.folding.offSide, true);
  const indent = new RegExp(configuration.indentationRules.increaseIndentPattern);
  assert.equal(indent.test('query result:'), true);
  assert.equal(indent.test('    select: # fields'), true);
  assert.equal(indent.test('# query result:'), false);
  assert.equal(indent.test('query result {'), false);
  const snippets = JSON.parse(readFileSync('snippets/pietto.json', 'utf8')) as Record<string, { body: string[] }>;
  assert.ok(Object.keys(snippets).length >= 4);
  for (const snippet of Object.values(snippets)) {
    // Ignore VS Code placeholder braces; Pietto block delimiters must remain colons.
    const expanded = snippet.body.join('\n').replace(/\$\{[^}]+\}/g, 'name').replace(/\$\d+/g, '');
    assert.ok(!/[{}]/.test(expanded));
    assert.ok(expanded.endsWith('\n'));
  }
});
