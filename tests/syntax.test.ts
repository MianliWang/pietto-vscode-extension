import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KEYWORD_SCOPE, loadGrammar, scopesAt, scopesOf, tokenize } from './grammarHost';

const isKeyword = (scopes: string[]) => scopes.some(scope => KEYWORD_SCOPE.test(scope));

/** The scopes of `text` (its `occurrence`-th match) on line `line` of a multi-line source. */
async function scopesIn(source: string, line: number, text: string, occurrence = 0): Promise<string[]> {
  const lines = source.split('\n');
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = lines[line].indexOf(text, start + 1);
  assert.notEqual(start, -1, `${text} in ${lines[line]}`);
  return scopesAt(tokenize(await loadGrammar(), source)[line], start);
}

test('real TextMate tokenization respects Pietto strings, comments and case', async () => {
  const line = 'source users: User = postgres.table("select \\" # from") # query';
  assert.ok((await scopesOf(line, 'source')).includes('storage.type.pietto'));
  assert.ok((await scopesOf(line, 'users')).includes('entity.name.type.pietto'));
  assert.ok((await scopesOf(line, 'select')).includes('string.quoted.double.pietto'));
  assert.ok((await scopesOf(line, '\\"')).includes('constant.character.escape.pietto'));
  assert.ok((await scopesOf(line, '"')).includes('punctuation.definition.string.begin.pietto'));
  assert.ok((await scopesOf(line, '# from')).includes('string.quoted.double.pietto'));
  assert.ok((await scopesOf(line, '# query')).includes('comment.line.number-sign.pietto'));
  assert.ok((await scopesOf("    note = 'where \\' select'", 'where')).includes('string.quoted.single.pietto'));
  assert.ok((await scopesOf("    note = 'where \\' select'", "\\'")).includes('constant.character.escape.pietto'));
  assert.ok((await scopesOf("    note = 'where \\' select'", 'select')).includes('string.quoted.single.pietto'), 'an escaped quote ends no string');
  for (const [text, occurrence] of [['<=', 0], ['<', 1], ['!=', 0], ['>', 0]] as const) {
    const scopes = await scopesOf('    where 0 <= x < 10 and y != 2 or z > 1', text, occurrence);
    assert.ok(scopes.includes('keyword.operator.comparison.pietto'), `${text}: ${scopes.join(' ')}`);
  }
  for (const text of ['hi', '# x']) assert.ok((await scopesOf(`    note = 'say "hi" # x'`, text)).includes('string.quoted.single.pietto'), text);
  assert.ok((await scopesOf(`    note = "it's # x"`, '# x')).includes('string.quoted.double.pietto'));
  assert.ok(!isKeyword(await scopesOf('QUERY result:', 'QUERY')));
  // `--` starts no comment: it is two minus signs.
  assert.ok((await scopesOf('    where amount > 100 -- 50', '--')).includes('keyword.operator.arithmetic.pietto'));
  assert.ok((await scopesOf('    where total > 10_000', '10_000')).includes('constant.numeric.pietto'));
  assert.ok((await scopesOf('    note = "open', '"')).includes('string.quoted.double.pietto'));
  assert.ok((await scopesOf('    note = "open', 'open')).every(scope => !scope.startsWith('comment')));
  const unclosed = tokenize(await loadGrammar(), '    note = "open\n    select id');
  assert.ok(unclosed[1].every(token => !token.scopes.some(scope => scope.startsWith('string'))), 'a string ends at its line');
  assert.ok((await scopesOf('shape A { id: Int }', '{')).includes('invalid.illegal.brace.pietto'));
});

test('contextual keywords remain names in declarations, fields, paths and aliases', async () => {
  const shape = 'shape Record:\n    group: Int | None\n    from: Text\n    where: Int\n    select: Bool\n    check: Bool';
  for (const [line, name] of [[1, 'group'], [2, 'from'], [3, 'where'], [4, 'select'], [5, 'check']] as const) {
    const scopes = await scopesIn(shape, line, name);
    assert.ok(scopes.includes('variable.other.member.pietto'), `${name}: ${scopes.join(' ')}`);
    assert.ok(!isKeyword(scopes), `${name} must stay a field name`);
  }
  for (const [line, name, scope] of [
    ['shape order:', 'order', 'entity.name.type.pietto'],
    ['source import: order = postgres.table("public.records")', 'import', 'entity.name.type.pietto'],
    ['source import: order = postgres.table("public.records")', 'table', 'entity.name.function.pietto'],
    ['        rows = source.order', 'rows', 'variable.other.pietto'],
    ['        source.order', 'order', 'variable.other.member.pietto'],
  ]) {
    const scopes = await scopesOf(line, name);
    assert.ok(scopes.includes(scope), `${line}: ${name}: ${scopes.join(', ')}`);
    assert.ok(!isKeyword(scopes), `${name} must stay an identifier`);
  }
  const query = [
    'query q(from: Int, order: Text):',
    '    from order',
    '    let group = 1',
    '    select:',
    '        asc', '        desc', '        rows', '        order', '        first', '        ignore',
    '        from', '        where', '        limit', '        select', '        on',
    '        first = min(label, "m")',
    '        total = sum(1 for o in group if o.paid)',
  ].join('\n');
  assert.ok((await scopesIn(query, 0, 'from')).includes('variable.parameter.pietto'));
  assert.ok((await scopesIn(query, 1, 'order')).includes('variable.other.pietto'));
  assert.ok((await scopesIn(query, 2, 'group')).includes('variable.other.pietto'));
  const lines = tokenize(await loadGrammar(), query);
  for (let line = 4; line <= 14; line++) assert.ok(lines[line].every(token => !isKeyword(token.scopes)), query.split('\n')[line]);
  assert.ok(!isKeyword(await scopesIn(query, 15, 'first')));
  assert.ok(!isKeyword(await scopesIn(query, 16, 'group')));
});

test('clause, join, window and frame words are keywords where the grammar reads them', async () => {
  const query = [
    'query ranked:',
    '    from accounts',
    '    let price = prices',
    '',
    '    asof left join price on accounts.id == price.id and accounts.at >= price.valid_from',
    '    let by_id = window(order by id)',
    '    where any(o.id == accounts.id for o in orders)',
    '    group by:',
    '        account_id',
    '    select distinct:',
    '        n = lag(amount, 1) window(order by id rows between unbounded preceding and current row exclude no others)',
    '        nth = nth_value(x, 2) from first ignore nulls window by_id',
    '        latest = last(plant, order by sold_at desc, id)',
    '        variance_ = pvariance(minutes)',
    '        pairs = count_distinct(plant, pot)',
    '        everyone = all(o.paid for o in group)',
    '        items = collect members',
    '    having n > 1',
    '    qualify row_number() window(partition by account_id order by id) <= 3',
    '    order by id asc',
    '    limit 10',
  ].join('\n');
  for (const [line, word, scope] of [
    [4, 'asof', 'keyword.other.clause.pietto'], [4, 'join', 'keyword.other.clause.pietto'], [4, 'on', 'keyword.other.clause.pietto'],
    [5, 'window', 'keyword.other.window.pietto'], [5, 'order', 'keyword.other.clause.pietto'],
    [6, 'any', 'support.function.builtin.aggregate.pietto'], [6, 'for', 'keyword.control.flow.pietto'], [6, 'in', 'keyword.operator.logical.pietto'],
    [7, 'group', 'keyword.other.clause.pietto'], [9, 'distinct', 'keyword.other.clause.pietto'],
    [10, 'rows', 'keyword.other.window.pietto'], [10, 'unbounded', 'keyword.other.window.pietto'], [10, 'preceding', 'keyword.other.window.pietto'],
    [10, 'current', 'keyword.other.window.pietto'], [10, 'exclude', 'keyword.other.window.pietto'], [10, 'others', 'keyword.other.window.pietto'],
    [11, 'from', 'keyword.other.window.pietto'], [11, 'ignore', 'keyword.other.window.pietto'], [11, 'nulls', 'keyword.other.window.pietto'],
    [11, 'nth_value', 'support.function.builtin.window.pietto'],
    [12, 'last', 'support.function.builtin.aggregate.pietto'], [12, 'desc', 'keyword.other.clause.pietto'],
    [13, 'pvariance', 'support.function.builtin.aggregate.pietto'], [14, 'count_distinct', 'support.function.builtin.aggregate.pietto'],
    [15, 'all', 'support.function.builtin.aggregate.pietto'], [16, 'collect', 'keyword.operator.word.pietto'],
    [17, 'having', 'keyword.other.clause.pietto'], [18, 'qualify', 'keyword.other.clause.pietto'], [18, 'partition', 'keyword.other.clause.pietto'],
    [19, 'asc', 'keyword.other.clause.pietto'], [20, 'limit', 'keyword.other.clause.pietto'], [20, '10', 'constant.numeric.pietto'],
  ] as const) {
    const scopes = await scopesIn(query, line, word);
    assert.ok(scopes.includes(scope), `${word} on line ${line}: ${scopes.join(' ')}`);
  }
  assert.ok(!isKeyword(await scopesIn(query, 11, 'by_id')), 'a window name stays a name');
  assert.ok(!isKeyword(await scopesIn(query, 15, 'group')), 'group after in is the group, a name');
});

// The frame forms docs/language.md lists (in a ```text fence the corpus does not read).
const FRAMES = [
  'rows 2 preceding',
  'rows between 2 preceding and current row',
  'range 2 preceding',
  'range between 2 preceding and current row',
  'groups 2 preceding',
  'groups between 2 preceding and current row',
  'rows between 2 preceding and 2 following exclude current row',
  'range current row exclude ties',
  'groups current row exclude group',
  'rows between unbounded preceding and n + 1 following',
  'groups between (n) preceding and unbounded following exclude no others',
];

test('every word of a documented window frame is scoped inline and in a window block', async () => {
  const grammar = await loadGrammar();
  for (const frame of FRAMES) {
    const source = ['query q:', '    from t', '    select:', `        a = sum(x) window(order by id ${frame})`,
      '        b = sum(x) window:', '            order by id', `            ${frame}`].join('\n');
    const text = source.split('\n');
    const lines = tokenize(grammar, source);
    for (const line of [3, 6]) {
      const start = text[line].indexOf(frame);
      for (const match of frame.matchAll(/\w+/g)) {
        const expected = match[0] === 'and' ? 'keyword.operator.logical.pietto'
          : /^\d/.test(match[0]) ? 'constant.numeric.pietto'
            : match[0] === 'n' ? undefined : 'keyword.other.window.pietto';
        const scopes = scopesAt(lines[line], start + (match.index ?? 0));
        if (expected) assert.ok(scopes.includes(expected), `${match[0]} in ${text[line]}: ${scopes.join(' ')}`);
        else assert.ok(!isKeyword(scopes), `${match[0]} in ${text[line]}: ${scopes.join(' ')}`);
      }
    }
  }
});

test('frame and field-constraint words used as names get no keyword scope', async () => {
  const source = [
    'shape Member:',
    '    derive: Int',
    '    total: Int | None derive id + 1 @pii ensure self >= 0',
    '    k = unique(derive)',
    '    i = index(ensure) when derive > 0',
    '    index j on rows, range when paid',
    'query q:',
    '    from members',
    '    where following > 1 and range between 1 and 5',
    '    group by preceding',
    '    select:',
    '        range * 2',
    '        following, rows',
    '    order by following',
  ].join('\n');
  for (const [line, word] of [
    [1, 'derive'], [3, 'derive'], [4, 'ensure'], [4, 'derive'], [5, 'rows'], [5, 'range'], [8, 'following'], [8, 'range'],
    [9, 'preceding'], [11, 'range'], [12, 'following'], [12, 'rows'], [13, 'following'],
  ] as const) {
    const scopes = await scopesIn(source, line, word);
    assert.ok(!isKeyword(scopes), `${word} on line ${line}: ${scopes.join(' ')}`);
  }
  for (const [line, word, scope] of [
    [2, 'derive', 'keyword.other.constraint.pietto'], [2, 'ensure', 'keyword.other.constraint.pietto'], [2, 'pii', 'storage.type.annotation.pietto'],
    [2, 'None', 'constant.language.pietto'], [4, 'when', 'keyword.other.constraint.pietto'], [5, 'when', 'keyword.other.constraint.pietto'],
    [8, 'between', 'keyword.operator.word.pietto'],
  ] as const) {
    const scopes = await scopesIn(source, line, word);
    assert.ok(scopes.includes(scope), `${word} on line ${line}: ${scopes.join(' ')}`);
  }
});

test('a name that only contains a keyword or built-in name is never scoped as one', async () => {
  const language = JSON.parse(readFileSync('tests/fixtures/language.json', 'utf8')) as Record<string, string[]>;
  const words = new Set([...language.keywords, ...language.types, ...language.functions, ...language.aggregates, ...language.windowFunctions, 'self', 'cast']);
  const wrong = (scope: string) => KEYWORD_SCOPE.test(scope) || /^(?:support|variable\.language|constant\.numeric)\./.test(scope);
  const grammar = await loadGrammar();
  for (const word of words) {
    for (const name of [`${word}x`, `x${word}`, `_${word}`, `${word}_1`]) {
      const text = [
        'shape S:', `    ${name}: Int`, `    k = unique(${name})`,
        'query q:', `    from ${name}`, `    where ${name} > 1 and ${name}`, `    group by ${name}`, '    select:',
        `        ${name}`, `        a = ${name}(${name}) + ${name}.${name}`, `    order by ${name} desc`, `    limit ${name}`,
        `def f(${name}: Int) -> Int: return ${name}`,
      ];
      tokenize(grammar, text.join('\n')).forEach((tokens, line) => {
        for (const match of text[line].matchAll(new RegExp(`(?<!\\w)${name}(?!\\w)`, 'g'))) {
          const start = match.index ?? 0;
          const bad = tokens.filter(token => token.start < start + name.length && token.end > start && token.scopes.some(wrong));
          assert.deepEqual(bad, [], `${name} in ${text[line]}`);
        }
      });
    }
  }
});

test('declarations, parameters, types, modules and retired header lines', async () => {
  const source = [
    'pietto 0.9',
    'mode checked',
    'from "models/a.pietto" import (',
    '    def pos as p,',
    '    source rows,',
    ')',
    'export relationship member_rides, shape Order',
    'cutoff: Date = "2024-01-31"',
    'type Price = Decimal(10, 2) ensure self >= 0',
    'def line_total(price: Int, quantity: Int) -> Int | None: return price * quantity if quantity > 0 else None',
    'relationship placed_by(order: Order, customer: Customer): order.customer_id == customer.id',
    'query recent(since: Timestamp, floor: Decimal(9, 2)):',
    '    values(id: Int, label: Text | None):',
    '        1, "new"',
    '    union all a_rows, b_rows',
  ].join('\n');
  const lines = tokenize(await loadGrammar(), source);
  for (const line of [0, 1]) assert.ok(lines[line].every(token => !isKeyword(token.scopes)), 'a retired header line gets no keyword scope');
  for (const [line, word, scope] of [
    [2, 'from', 'keyword.control.import.pietto'], [2, 'import', 'keyword.control.import.pietto'],
    [3, 'def', 'storage.type.pietto'], [3, 'pos', 'entity.name.function.pietto'], [3, 'as', 'keyword.control.import.pietto'],
    [4, 'source', 'storage.type.pietto'], [4, 'rows', 'entity.name.type.pietto'],
    [6, 'export', 'keyword.control.import.pietto'], [6, 'relationship', 'storage.type.pietto'],
    [7, 'cutoff', 'variable.other.constant.pietto'], [7, 'Date', 'support.type.builtin.pietto'],
    [8, 'Decimal', 'support.type.builtin.pietto'], [8, '10', 'constant.numeric.pietto'], [8, 'ensure', 'keyword.other.constraint.pietto'],
    [8, 'self', 'variable.language.self.pietto'],
    [9, 'line_total', 'entity.name.function.pietto'], [9, 'price', 'variable.parameter.pietto'], [9, 'None', 'constant.language.pietto'],
    [9, 'return', 'keyword.control.flow.pietto'], [9, 'if', 'keyword.control.flow.pietto'], [9, 'else', 'keyword.control.flow.pietto'],
    [10, 'order', 'variable.parameter.pietto'], [10, 'Customer', 'entity.name.type.pietto'],
    [11, 'since', 'variable.parameter.pietto'], [11, 'Timestamp', 'support.type.builtin.pietto'],
    [12, 'values', 'keyword.other.clause.pietto'], [12, 'label', 'variable.parameter.pietto'],
    [14, 'union', 'keyword.other.clause.pietto'], [14, 'all', 'keyword.other.clause.pietto'],
  ] as const) {
    const scopes = await scopesIn(source, line, word);
    assert.ok(scopes.includes(scope), `${word} on line ${line}: ${scopes.join(' ')}`);
  }
  // A blank line and a column-0 comment keep the block open.
  const block = 'query q:\n    from orders\n\n# note\n    select id';
  assert.ok((await scopesIn(block, 4, 'select')).includes('keyword.other.clause.pietto'));
  // So does the `)` of a header whose parameters span lines.
  const header = 'def f(\n    a: Int,\n) -> Int:\n    return a';
  assert.ok((await scopesIn(header, 1, 'a')).includes('variable.parameter.pietto'));
  assert.ok((await scopesIn(header, 3, 'return')).includes('keyword.control.flow.pietto'));
  // A module list that is still open while typing ends at the next column-0 line.
  for (const opening of ['from "models/a.pietto" import (', 'export (']) {
    const typing = `${opening}\n    source orders,\nquery q:\n    from orders\n    select id`;
    assert.ok((await scopesIn(typing, 1, 'source')).includes('storage.type.pietto'), opening);
    assert.ok((await scopesIn(typing, 2, 'query')).includes('storage.type.pietto'), opening);
    assert.ok((await scopesIn(typing, 4, 'select')).includes('keyword.other.clause.pietto'), opening);
  }
  const exported = 'export (\n    source orders,\n    shape Order,\n)\nquery q:\n    from orders';
  assert.ok((await scopesIn(exported, 2, 'Order')).includes('entity.name.type.pietto'));
  assert.ok((await scopesIn(exported, 3, ')')).includes('punctuation.parenthesis.end.pietto'));
  assert.ok((await scopesIn(exported, 5, 'from')).includes('keyword.other.clause.pietto'));
});

test('editing configuration follows the colon and indentation grammar', () => {
  const configuration = JSON.parse(readFileSync('language-configuration.json', 'utf8'));
  assert.equal(configuration.comments.lineComment, '#');
  assert.deepEqual(configuration.brackets, [['(', ')']]);
  assert.equal(configuration.folding.offSide, true);
  const pairs = configuration.autoClosingPairs.map((pair: { open: string }) => pair.open);
  assert.deepEqual(pairs, ['(', '"', "'"]);
  const increase = new RegExp(configuration.indentationRules.increaseIndentPattern);
  for (const line of ['query result:', '    select: # fields', '    let recent:', 'from "a.pietto" import (', 'def f(x: Int) -> Int:']) {
    assert.equal(increase.test(line), true, line);
  }
  for (const line of ['# query result:', 'query result {', '    id: Int', 'x = 1  # note:', '    select id']) {
    assert.equal(increase.test(line), false, line);
  }
  assert.equal(new RegExp(configuration.indentationRules.decreaseIndentPattern).test(')'), true);
  const outdent = configuration.onEnterRules.find((rule: { action: { indent: string } }) => rule.action.indent === 'outdent');
  assert.equal(new RegExp(outdent.beforeText).test('    return x > 0'), true);
  assert.equal(new RegExp(outdent.beforeText).test('def f() -> Int: return 1'), false);
  // A `return (` line indents for its open parenthesis instead.
  for (const line of ['    return (', '    return f(  # note']) assert.equal(new RegExp(outdent.beforeText).test(line), false, line);
  const word = new RegExp(`^(?:${configuration.wordPattern})$`);
  for (const text of ['order_id', '_x1', '10_000', '1.5']) assert.equal(word.test(text), true, text);
  for (const text of ['a.b', '"x"', '1_']) assert.equal(word.test(text), false, text);
});
