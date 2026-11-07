import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { python } from './editor';
import { root } from './grammarHost';

// The check runs the PIETTO_TEST_PYTHON interpreter without -I, so PYTHONPATH
// set to a Pietto tree's src chooses the tree.
const snippets = JSON.parse(readFileSync(path.join(root, 'snippets/pietto.json'), 'utf8')) as Record<string, { prefix: string | string[]; body: string[] }>;
const language = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/language.json'), 'utf8')) as Record<string, string[]>;
// Words that are typed as a call: a snippet with such a prefix inserts the call.
const calls = new Set([...language.functions, ...language.aggregates, ...language.windowFunctions, 'check', 'unique', 'index']);

/** A snippet body with every placeholder replaced by its default (the first choice). */
function expand(body: string[]): string {
  const values = new Map<string, string>();
  let text = body.join('\n');
  for (let previous = ''; previous !== text;) {
    previous = text;
    text = text
      .replace(/\$\{(\d+):([^${}]*)\}/g, (_, index: string, value: string) => (values.set(index, value), value))
      .replace(/\$\{(\d+)\|([^|]*)\|\}/g, (_, index: string, choices: string) => {
        const value = choices.split(',')[0];
        values.set(index, value);
        return value;
      });
  }
  return text.replace(/\$\{(\d+)\}|\$(\d+)/g, (_, braced?: string, bare?: string) => values.get(braced ?? bare ?? '') ?? '');
}

const indent = (text: string, width = 4) => text.split('\n').map(line => ' '.repeat(width) + line).join('\n');
const file = (...declarations: string[]) => declarations.join('\n\n') + '\n';

const ORDER = 'shape Order:\n    id: Int\n    customer_id: Int\n    amount_cents: Int\n    paid: Bool';
const ORDERS = 'source orders: Order = postgres.table("shop.orders")';
const CUSTOMER = 'shape Customer:\n    id: Int\n    name: Text';
const CUSTOMERS = 'source customers: Customer = postgres.table("shop.customers")';
const SALE = 'shape Sale:\n    id: Int\n    shop_id: Int\n    plant: Text\n    sold_at: Timestamp\n    sale_key = unique(id)';
const SALES = 'source sales: Sale = postgres.table("nursery.sales")';

// Each single-file snippet inside the smallest file that checks it.
const singleFile: Record<string, (snippet: string) => string> = {
  Shape: snippet => file(snippet),
  'Unique key': snippet => file(`shape Order:\n    id: Int\n    order_key = ${snippet}`),
  Enum: snippet => file(snippet),
  Source: snippet => file('shape Order:\n    id: Int', snippet),
  Query: snippet => file(ORDER, ORDERS, snippet),
  'Grouped query': snippet => file(ORDER, ORDERS, snippet),
  'Join query': snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS, snippet),
  Join: snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS,
    `query q:\n    from orders\n${indent(snippet)}\n    select order_id = orders.id, customer_name = customer.name`),
  'Count matching rows': snippet => file(ORDER, ORDERS,
    `query q:\n    from orders\n    group by customer_id\n    select:\n        customer_id\n        paid_orders = ${snippet}`),
  'First value': snippet => file(SALE, SALES,
    `query q:\n    from sales\n    group by shop_id\n    select:\n        shop_id\n        first_plant = ${snippet}`),
  'Last value': snippet => file(SALE, SALES,
    `query q:\n    from sales\n    group by shop_id\n    select:\n        shop_id\n        last_plant = ${snippet}`),
  Def: snippet => file(snippet),
  Relationship: snippet => file('shape Order:\n    id: Int\n    customer_id: Int', 'shape Customer:\n    id: Int', snippet),
};
// Import and Export need an explicit-module project: Export in the module that
// declares `orders`, Import in the module that reads it.
const projectSnippets = ['Export', 'Import'];

function pietto(...args: string[]) {
  const run = spawnSync(python(), ['-B', '-c', 'import sys; from pietto.cli import main; sys.exit(main(sys.argv[1:]))', ...args], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}${run.error ?? ''}` };
}

function assertClean(paths: string[], checkArgs: string[]) {
  const check = pietto('check', ...checkArgs);
  assert.equal(check.status, 0, check.output);
  assert.doesNotMatch(check.output, /PIE-/, check.output);
  for (const target of paths) {
    const format = pietto('fmt', '--check', target);
    assert.equal(format.status, 0, `${target}\n${readFileSync(target, 'utf8')}\n${format.output}`);
  }
}

test('every snippet has a checking case and expands without placeholders or braces', () => {
  assert.deepEqual(Object.keys(snippets).sort(), [...Object.keys(singleFile), ...projectSnippets].sort());
  for (const [name, snippet] of Object.entries(snippets)) {
    const text = expand(snippet.body);
    assert.doesNotMatch(text, /[${}]/, `${name}: ${text}`);
    assert.doesNotMatch(text, /\t|'| +$/m, `${name}: tabs, single quotes or trailing spaces`);
    assert.doesNotMatch(text, /\b(?:asc|nullable|not null|is postgres|true|false|null)\b/, `${name}: a retired or redundant spelling`);
    // Typing `sum(` or `k = unique(` must not insert a second `name =`.
    if ([snippet.prefix].flat().some(prefix => calls.has(prefix))) assert.doesNotMatch(text, /^\w+ *=/, `${name}: inserts an assignment`);
  }
});

test('expanded snippets pass the real Pietto check and are already formatted', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pietto-snippets-'));
  try {
    for (const [name, wrap] of Object.entries(singleFile)) {
      const target = path.join(directory, `${name.replace(/\W+/g, '_')}.pietto`);
      writeFileSync(target, wrap(expand(snippets[name].body)));
      assertClean([target], ['--check-mode', 'strict', target]);
    }
    const project = path.join(directory, 'project');
    mkdirSync(path.join(project, 'models'), { recursive: true });
    writeFileSync(path.join(project, 'pietto.toml'), 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n');
    const exporter = path.join(project, 'models/a.pietto');
    const importer = path.join(project, 'models/b.pietto');
    writeFileSync(exporter, file(expand(snippets.Export.body), 'shape Order:\n    id: Int', ORDERS));
    writeFileSync(importer, file(`${expand(snippets.Import.body)}\n\nquery order_ids:\n    from orders\n    select id`));
    assertClean([exporter, importer], ['--project', project]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
