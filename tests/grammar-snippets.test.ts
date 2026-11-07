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
const SALE = 'shape Sale:\n    id: Int\n    shop_id: Int\n    plant: Text\n    pot: Text\n    sold_at: Timestamp\n    sale_key = unique(id)';
const SALES = 'source sales: Sale = postgres.table("nursery.sales")';
const PRICED = [
  'shape Order:\n    id: Int\n    product_id: Int\n    ordered_at: Timestamp',
  'shape Price:\n    product_id: Int\n    valid_from: Timestamp\n    amount_cents: Int\n    price_key = unique(product_id, valid_from)',
  ORDERS,
  'source prices: Price = postgres.table("shop.prices")',
];
// A select item of a query grouped by customer, or by shop.
const perCustomer = (item: string) => file(ORDER, ORDERS,
  `query q:\n    from orders\n    group by customer_id\n    select:\n        customer_id\n        ${item}`);
const perShop = (item: string) => file(SALE, SALES,
  `query q:\n    from sales\n    group by shop_id\n    select:\n        shop_id\n        ${item}`);

// Each single-file snippet inside the smallest file that checks it.
const singleFile: Record<string, (snippet: string) => string> = {
  Shape: snippet => file(snippet),
  'Unique key': snippet => file(`shape Order:\n    id: Int\n    order_key = ${snippet}`),
  Enum: snippet => file(snippet),
  Constant: snippet => file(snippet),
  Source: snippet => file('shape Order:\n    id: Int', snippet),
  Query: snippet => file(ORDER, ORDERS, snippet),
  'Grouped query': snippet => file(ORDER, ORDERS, snippet),
  'Join query': snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS, snippet),
  Join: snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS,
    `query q:\n    from orders\n${indent(snippet)}\n    select order_id = orders.id, customer_name = customer.name`),
  'Asof join': snippet => file(...PRICED,
    `query order_prices:\n    from orders\n${indent(snippet)}\n    select order_id = orders.id, price_cents = price.amount_cents`),
  'Count matching rows': snippet => perCustomer(`paid_orders = ${snippet}`),
  'First value': snippet => perShop(`first_plant = ${snippet}`),
  'Last value': snippet => perShop(`last_plant = ${snippet}`),
  Median: snippet => perCustomer(`median_cents = ${snippet}`),
  Quantile: snippet => perCustomer(`p90_cents = ${snippet}`),
  Variance: snippet => perCustomer(`cents_variance = ${snippet}`),
  'Distinct combinations': snippet => perShop(`plant_pots = ${snippet}`),
  'Any row': snippet => perCustomer(`any_paid = ${snippet}`),
  'All rows': snippet => perCustomer(`all_paid = ${snippet}`),
  Def: snippet => file(snippet),
  Relationship: snippet => file('shape Order:\n    id: Int\n    customer_id: Int', 'shape Customer:\n    id: Int', snippet),
};
// Each snippet that needs an explicit-module project inside the one module of
// the smallest project that checks it.
const projectModule: Record<string, (snippet: string) => string> = {
  'Query parameter': snippet => file(ORDER, ORDERS, snippet),
  'Collect query': snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS, snippet),
  Unnest: snippet => file(CUSTOMER, ORDER, CUSTOMERS, ORDERS, expand(snippets['Collect query'].body),
    `query order_lines:\n    from customer_orders\n${indent(snippet)}\n    select name, amount_cents`),
};
// Import and Export need two modules: Export in the module that declares
// `orders`, Import in the module that reads it.
const projectSnippets = ['Export', 'Import'];

function pietto(...args: string[]) {
  const run = spawnSync(python(), ['-B', '-c', 'import sys; from pietto.cli import main; sys.exit(main(sys.argv[1:]))', ...args], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}${run.error ?? ''}` };
}

/** An explicit-module project in `directory` whose modules are models/<name>. */
function project(directory: string, modules: Record<string, string>): string[] {
  mkdirSync(path.join(directory, 'models'), { recursive: true });
  writeFileSync(path.join(directory, 'pietto.toml'), 'schema_version = 2\n\n[sources]\ninclude = ["models/*.pietto"]\n');
  return Object.entries(modules).map(([name, text]) => {
    const target = path.join(directory, 'models', name);
    writeFileSync(target, text);
    return target;
  });
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
  assert.deepEqual(Object.keys(snippets).sort(), [...Object.keys(singleFile), ...Object.keys(projectModule), ...projectSnippets].sort());
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
    for (const [name, wrap] of Object.entries(projectModule)) {
      const folder = path.join(directory, name.replace(/\W+/g, '_'));
      assertClean(project(folder, { 'a.pietto': wrap(expand(snippets[name].body)) }), ['--project', folder]);
    }
    const pair = path.join(directory, 'Export_Import');
    assertClean(project(pair, {
      'a.pietto': file(expand(snippets.Export.body), 'shape Order:\n    id: Int', ORDERS),
      'b.pietto': file(`${expand(snippets.Import.body)}\n\nquery order_ids:\n    from orders\n    select id`),
    }), ['--project', pair]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
