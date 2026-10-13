import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import net from 'node:net';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { connectionSourceKey, parseConnections } from '../src/connections';

function configuration() {
  return {
    version: 1,
    profiles: [{ id: 'local', displayName: 'Local warehouse', provider: 'postgres', host: 'localhost', port: 5432, database: 'analytics' }],
    bindings: [{ module: 'models/orders.pietto', source: 'Warehouse', profile: 'local', tables: [{ declaration: 'Orders', schema: 'public', table: 'orders' }] }],
  };
}

type ConfigurationFixture = ReturnType<typeof configuration>;

test('projects documented non-secret descriptors and explicit mappings', () => {
  const input = configuration();
  const result = parseConnections(JSON.stringify(input));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.profiles, input.profiles);
  assert.deepEqual(result.bindings, input.bindings);
  assert.equal(connectionSourceKey('file:///workspace/one', 'orders.pietto', 'Warehouse'), '["file:///workspace/one","orders.pietto","Warehouse"]');
  assert.notEqual(connectionSourceKey('file:///workspace/one', 'orders.pietto', 'Warehouse'), connectionSourceKey('file:///workspace/two', 'orders.pietto', 'Warehouse'));
  assert.notEqual(connectionSourceKey('file:///workspace/one', 'models/orders.pietto', 'Warehouse'), connectionSourceKey('file:///workspace/one', 'reports/orders.pietto', 'Warehouse'));
});

test('empty profiles and bindings are a valid unconfigured preview', () => {
  assert.deepEqual(parseConnections('{"version":1,"profiles":[],"bindings":[]}'), { profiles: [], bindings: [], issues: [] });
  assert.deepEqual(parseConnections('\ufeff{\r\n"version":1,"profiles":[],"bindings":[]\r\n}'), { profiles: [], bindings: [], issues: [] });
});

test('unknown or secret-bearing input invalidates all configuration without echoing raw keys or values', () => {
  const secret = 'never-display-super-secret';
  const mutations = [
    (input: ConfigurationFixture) => { Reflect.set(input.profiles[0], 'password', secret); },
    (input: ConfigurationFixture) => { Reflect.set(input.profiles[0], 'token', secret); },
    (input: ConfigurationFixture) => { Reflect.set(input.profiles[0], secret, secret); },
    (input: ConfigurationFixture) => { Reflect.set(input.profiles[0], 'url', `postgres://user:${secret}@localhost/db`); },
    (input: ConfigurationFixture) => { input.profiles[0].host = `postgres://user:${secret}@localhost/db`; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = `password=${secret}`; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = `-----BEGIN PRIVATE KEY-----${secret}`; },
    (input: ConfigurationFixture) => { input.profiles[0].database = '${DATABASE}'; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = '%DATABASE%'; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = '$DATABASE'; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = `Bearer ${secret}`; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = 'ghp_123456789012345678901234567890123456'; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'; },
    (input: ConfigurationFixture) => { Reflect.set(input.bindings[0].tables[0], 'script', secret); },
    (input: ConfigurationFixture) => { Reflect.set(input.bindings[0], 'env', secret); },
  ];
  for (const mutate of mutations) {
    const input = configuration();
    mutate(input);
    const result = parseConnections(JSON.stringify(input));
    assert.ok(result.issues.length > 0);
    assert.deepEqual(result.profiles, []);
    assert.deepEqual(result.bindings, []);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.ok(parseConnections('{"version":1,"profiles":[],"bindings":[],"__proto__":{"password":"never-display-super-secret"}}').issues.length > 0);
});

test('malformed JSON diagnostics never include source content', () => {
  const result = parseConnections('{"password":"never-display-super-secret"');
  assert.deepEqual(result, { profiles: [], bindings: [], issues: [{ path: '$', message: 'Configuration is not valid JSON.' }] });
});

test('validates required fields, limits, unique identities, and profile references', () => {
  const mutations = [
    (input: ConfigurationFixture) => { input.version = 2; },
    (input: ConfigurationFixture) => { Reflect.deleteProperty(input, 'profiles'); },
    (input: ConfigurationFixture) => { Reflect.set(input, 'profiles', null); },
    (input: ConfigurationFixture) => { Reflect.set(input.profiles, 0, null); },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = ''; },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = 'x'.repeat(121); },
    (input: ConfigurationFixture) => { input.profiles[0].displayName = 'name\nnewline'; },
    (input: ConfigurationFixture) => { input.profiles[0].port = 0; },
    (input: ConfigurationFixture) => { input.profiles[0].port = 65536; },
    (input: ConfigurationFixture) => { input.profiles[0].port = 1.5; },
    (input: ConfigurationFixture) => { Reflect.set(input.profiles[0], 'port', '5432'); },
    (input: ConfigurationFixture) => { input.profiles.push(input.profiles[0]); },
    (input: ConfigurationFixture) => { input.bindings.push(input.bindings[0]); },
    (input: ConfigurationFixture) => { input.bindings[0].profile = 'missing'; },
    (input: ConfigurationFixture) => { input.bindings[0].source = 'a.b'; },
    (input: ConfigurationFixture) => { input.bindings[0].tables.push(input.bindings[0].tables[0]); },
    (input: ConfigurationFixture) => { input.bindings[0].tables[0].table = 'public.orders'; },
    (input: ConfigurationFixture) => { input.profiles = Array(101).fill(input.profiles[0]); },
  ];
  for (const mutate of mutations) {
    const input = configuration();
    mutate(input);
    const result = parseConnections(JSON.stringify(input));
    assert.ok(result.issues.length > 0);
    assert.deepEqual(result.profiles, []);
    assert.deepEqual(result.bindings, []);
  }
});

test('rejects ambiguous, absolute, and escaping module paths; preserves non-ASCII path identity', () => {
  for (const module of ['../orders.pietto', '/orders.pietto', 'C:/orders.pietto', 'models\\orders.pietto', './orders.pietto', 'models/../orders.pietto', 'models//orders.pietto', 'orders.sql']) {
    const input = configuration();
    input.bindings[0].module = module;
    assert.ok(parseConnections(JSON.stringify(input)).issues.length > 0);
  }
  const input = configuration();
  input.bindings[0].module = '模型/订单.pietto';
  const result = parseConnections(JSON.stringify(input));
  assert.deepEqual(result.issues, []);
  assert.equal(result.bindings[0].module, '模型/订单.pietto');
});

test('preview parsing performs no TCP, DNS, fetch, or child-process operation', () => {
  const forbidden = (): never => { throw new Error('Preview attempted a network or process operation.'); };
  const spies = [
    mock.method(net, 'connect', forbidden),
    mock.method(net, 'createConnection', forbidden),
    mock.method(net.Socket.prototype, 'connect', forbidden),
    mock.method(dns, 'lookup', forbidden),
    mock.method(dns, 'resolve', forbidden),
    mock.method(childProcess, 'spawn', forbidden),
    mock.method(childProcess, 'exec', forbidden),
    mock.method(childProcess, 'execFile', forbidden),
    mock.method(childProcess, 'fork', forbidden),
    mock.method(globalThis, 'fetch', forbidden),
  ];
  try {
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(parseConnections(JSON.stringify(configuration())).issues, []);
      assert.ok(parseConnections('{"token":"secret"}').issues.length > 0);
    }
    for (const spy of spies) { assert.equal(spy.mock.callCount(), 0); }
  } finally {
    for (const spy of spies) { spy.mock.restore(); }
  }
});
