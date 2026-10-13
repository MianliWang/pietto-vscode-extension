/** Extension-owned, secret-free configuration. It never establishes a live connection. */
export interface ConnectionProfile {
  id: string;
  displayName: string;
  provider: string;
  host?: string;
  port?: number;
  database?: string;
}

export interface PhysicalTableMapping {
  declaration: string;
  schema?: string;
  table: string;
}

export interface SourceBinding {
  module: string;
  source: string;
  profile: string;
  tables?: PhysicalTableMapping[];
}

export interface ConnectionIssue {
  path: string;
  message: string;
}

export interface ConnectionConfiguration {
  profiles: ConnectionProfile[];
  bindings: SourceBinding[];
  issues: ConnectionIssue[];
}

const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const providerPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const controlPattern = /[\u0000-\u001f\u007f]/;
const unsafeDescriptorPattern = /(?:[a-z][a-z0-9+.-]*:\/\/|\S+:[^\s@]+@|\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|\{\{|-----BEGIN|(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key|access[_-]?key)\s*[:=])/i;
const recognizableCredentialPattern = /(?:\b(?:Bearer|Basic)\s+\S{8,}|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})|(?:^|\s)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collision-free identity: module/source names alone never identify a workspace declaration. */
export function connectionSourceKey(rootUri: string, module: string, source: string): string {
  return JSON.stringify([rootUri, module, source]);
}

/** Parse without I/O. A single issue invalidates the complete configuration. */
export function parseConnections(text: string): ConnectionConfiguration {
  const issues: ConnectionIssue[] = [];
  const profiles: ConnectionProfile[] = [];
  const bindings: SourceBinding[] = [];
  const issue = (path: string, message: string): void => { if (issues.length < 100) { issues.push({ path, message }); } };
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    return { profiles, bindings, issues: [{ path: '$', message: 'Configuration exceeds the 1 MiB text limit.' }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text);
  } catch {
    return { profiles, bindings, issues: [{ path: '$', message: 'Configuration is not valid JSON.' }] };
  }

  function record(input: unknown, path: string, allowed: readonly string[]): input is Record<string, unknown> {
    if (!isRecord(input)) {
      issue(path, 'Expected a JSON object.');
      return false;
    }
    if (Object.keys(input).some(key => !allowed.includes(key))) {
      issue(path, 'Unknown fields are forbidden. Only documented non-secret descriptors are accepted.');
    }
    return true;
  }

  function string(input: unknown, path: string, maxLength: number, pattern?: RegExp): input is string {
    if (typeof input !== 'string' || input.length === 0 || input.length > maxLength
        || input.trim() !== input || controlPattern.test(input)) {
      issue(path, 'Expected a nonempty, bounded, single-line string without surrounding whitespace.');
      return false;
    }
    if (unsafeDescriptorPattern.test(input) || recognizableCredentialPattern.test(input)) {
      issue(path, 'Credentials, URIs, private-key material, and environment interpolation are forbidden.');
      return false;
    }
    if (pattern && !pattern.test(input)) {
      issue(path, 'The descriptor does not match the documented format.');
      return false;
    }
    return true;
  }

  function array(input: unknown, path: string, limit: number): input is unknown[] {
    if (!Array.isArray(input) || input.length > limit) {
      issue(path, `Expected an array containing at most ${limit} entries.`);
      return false;
    }
    return true;
  }

  if (!record(value, '$', ['version', 'profiles', 'bindings'])) {
    return { profiles, bindings, issues };
  }
  if (value.version !== 1) { issue('version', 'Only configuration version 1 is supported.'); }
  const profileIds = new Set<string>();
  if (array(value.profiles, 'profiles', 100)) {
    value.profiles.forEach((input, index) => {
      const path = `profiles[${index}]`;
      if (!record(input, path, ['id', 'displayName', 'provider', 'host', 'port', 'database'])) { return; }
      const start = issues.length;
      const idOk = string(input.id, `${path}.id`, 64, idPattern);
      string(input.displayName, `${path}.displayName`, 120);
      string(input.provider, `${path}.provider`, 64, providerPattern);
      if ('host' in input) {
        string(input.host, `${path}.host`, 253, /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?|\[?[0-9A-Fa-f:]+\]?)$/);
      }
      if ('port' in input && (typeof input.port !== 'number' || !Number.isInteger(input.port)
          || input.port < 1 || input.port > 65535)) {
        issue(`${path}.port`, 'Expected an integer port between 1 and 65535.');
      }
      if ('database' in input) { string(input.database, `${path}.database`, 128, /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/); }
      if (idOk && profileIds.has(input.id as string)) { issue(`${path}.id`, 'Profile identifiers must be unique.'); }
      if (idOk) { profileIds.add(input.id as string); }
      if (issues.length !== start) { return; }
      // Copy the reviewed allowlist only; never expose raw configuration objects.
      const profile: ConnectionProfile = {
        id: input.id as string,
        displayName: input.displayName as string,
        provider: input.provider as string,
      };
      if ('host' in input) { profile.host = input.host as string; }
      if ('port' in input) { profile.port = input.port as number; }
      if ('database' in input) { profile.database = input.database as string; }
      profiles.push(profile);
    });
  }

  const bindingIds = new Set<string>();
  if (array(value.bindings, 'bindings', 500)) {
    value.bindings.forEach((input, index) => {
      const path = `bindings[${index}]`;
      if (!record(input, path, ['module', 'source', 'profile', 'tables'])) { return; }
      const start = issues.length;
      const moduleOk = string(input.module, `${path}.module`, 1024);
      if (moduleOk && ((input.module as string).includes('\\') || (input.module as string).includes(':')
          || !(input.module as string).endsWith('.pietto')
          || (input.module as string).split('/').some(part => part === '' || part === '.' || part === '..'))) {
        issue(`${path}.module`, 'Expected a workspace-relative .pietto path using forward slashes, without parent segments.');
      }
      const sourceOk = string(input.source, `${path}.source`, 128, identifierPattern);
      const profileOk = string(input.profile, `${path}.profile`, 64, idPattern);
      if (profileOk && !profileIds.has(input.profile as string)) {
        issue(`${path}.profile`, 'Binding references an unknown profile.');
      }
      if (moduleOk && sourceOk) {
        const bindingId = JSON.stringify([input.module, input.source]);
        if (bindingIds.has(bindingId)) { issue(path, 'Only one binding is allowed for each module and source.'); }
        bindingIds.add(bindingId);
      }
      const tables: PhysicalTableMapping[] = [];
      if ('tables' in input && array(input.tables, `${path}.tables`, 500)) {
        const tableIds = new Set<string>();
        input.tables.forEach((entry, tableIndex) => {
          const tablePath = `${path}.tables[${tableIndex}]`;
          if (!record(entry, tablePath, ['declaration', 'schema', 'table'])) { return; }
          const tableStart = issues.length;
          const declarationOk = string(entry.declaration, `${tablePath}.declaration`, 128, identifierPattern);
          string(entry.table, `${tablePath}.table`, 128, identifierPattern);
          if ('schema' in entry) { string(entry.schema, `${tablePath}.schema`, 128, identifierPattern); }
          if (declarationOk && tableIds.has(entry.declaration as string)) {
            issue(`${tablePath}.declaration`, 'Table declaration mappings must be unique within a source binding.');
          }
          if (declarationOk) { tableIds.add(entry.declaration as string); }
          if (issues.length !== tableStart) { return; }
          const table: PhysicalTableMapping = { declaration: entry.declaration as string, table: entry.table as string };
          if ('schema' in entry) { table.schema = entry.schema as string; }
          tables.push(table);
        });
      }
      if (issues.length !== start) { return; }
      const binding: SourceBinding = {
        module: input.module as string,
        source: input.source as string,
        profile: input.profile as string,
      };
      if ('tables' in input) { binding.tables = tables; }
      bindings.push(binding);
    });
  }
  return issues.length ? { profiles: [], bindings: [], issues } : { profiles, bindings, issues };
}
