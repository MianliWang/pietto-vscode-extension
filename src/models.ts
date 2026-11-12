import {explainArguments} from './launch';
import {Cancellation, isRecord, run, shown} from './preview';

// One line of the Pietto Models view under a project root: a relation, a column or a message.
export interface Node {
  readonly label: string;
  readonly description?: string;
  readonly children?: readonly Node[];
}

export type ModelItem = {readonly root: string} | Node;

class Unreadable extends Error {}

const unreadable = (reason: string): never => { throw new Unreadable(reason); };
const quoted = (value: unknown) => JSON.stringify(value) ?? String(value);
const text = (value: unknown, what: string) => typeof value === 'string' ? shown(value) : unreadable(`${what} is not a string`);
const list = (value: unknown, what: string) => Array.isArray(value) ? value : unreadable(`${what} is not a list`);
const nullabilities: readonly unknown[] = ['non_null', 'nullable', 'unknown'];

// A column as `name: Type` with its nullability as Pietto writes it; an enum or a shape also
// names its declaring module, and a collection lists its element columns.
function column(value: unknown, element: boolean): Node {
  if (!isRecord(value) || !isRecord(value.type)) return unreadable('a column is not an object with a type');
  const {type} = value;
  const label = text(value.name, 'a column name');
  if (!nullabilities.includes(value.nullability)) return unreadable(`unknown nullability ${quoted(value.nullability)}`);
  const nullability = value.nullability as string;
  switch (type.kind) {
    case 'builtin':
      return {label: `${label}: ${text(type.name, 'a type name')}`, description: nullability};
    case 'type_alias':
    case 'unknown':
      return {label: `${label}: ${text(type.name, 'a type name')}`, description: `${nullability}, ${type.kind}`};
    case 'enum':
    case 'shape':
      return {label: `${label}: ${text(type.name, 'a type name')}`, description: `${nullability}, ${type.kind} from ${text(type.module, 'a type module')}`};
    case 'collection':
      if (element) return unreadable('a collection inside a collection');
      return {label: `${label}: collection`, description: nullability, children: list(type.element, 'a collection element').map(item => column(item, true))};
  }
  return unreadable(`unknown type kind ${quoted(type.kind)}`);
}

function relation(value: unknown): Node {
  if (!isRecord(value)) return unreadable('a relation is not an object');
  if (value.kind !== 'table' && value.kind !== 'query') return unreadable(`unknown relation kind ${quoted(value.kind)}`);
  return {label: `${value.kind} ${text(value.name, 'a relation name')}`, description: text(value.module, 'a relation module'),
    children: list(value.columns, 'the columns of a relation').map(item => column(item, false))};
}

const counted = (count: number) => `${count} diagnostic${count === 1 ? '' : 's'}, see Problems.`;

// `explain --project` answers a schema_version 2 project with the alpha document
// pietto.project-relation-columns.v1 and anything else with pietto.project-explain.v1. The
// exit code must be the one `ok` documents (0, else 1 or 2); fields it does not read are
// ignored. Anything else it cannot read replaces the whole root, never part of it.
function relations(value: unknown, exit: number | null): Node[] {
  if (!isRecord(value)) return unreadable('the output is not a JSON object');
  const {format, ok} = value;
  if (format !== 'pietto.project-relation-columns.v1' && format !== 'pietto.project-explain.v1') return unreadable(`unknown format ${quoted(format)}`);
  if (typeof ok !== 'boolean' || (ok ? exit !== 0 : exit !== 1 && exit !== 2)) return unreadable(`exit code ${exit} with ok ${quoted(ok)}`);
  const diagnostics = list(value.diagnostics, 'diagnostics');
  if (format === 'pietto.project-explain.v1') {
    // Its failures are configuration and root errors, each a diagnostic with the error kind as code.
    if (ok) return [{label: 'This is a schema_version 4 project; Pietto lists relation columns only for schema_version 2.'}];
    if (!diagnostics.length) return unreadable('ok false without a diagnostic');
    return diagnostics.map(item => isRecord(item) ? {label: `project error: ${text(item.code, 'an error code')}: ${text(item.message, 'an error message')}`} : unreadable('a diagnostic is not an object'));
  }
  const errors = list(value.cli_errors, 'cli_errors').map(item => isRecord(item)
    ? {label: `project error: ${text(item.kind, 'a CLI error kind')}: ${text(item.message, 'a CLI error message')}`} : unreadable('a CLI error is not an object'));
  if (ok) {
    if (errors.length) return unreadable('CLI errors with ok true');
    const found = list(value.relations, 'relations').map(relation);
    return found.length ? found : [{label: 'The project has no tables or queries.'}];
  }
  if (value.relations !== null) return unreadable('relations with ok false');
  if (!errors.length && !diagnostics.length) return unreadable('ok false without a diagnostic or CLI error');
  if (exit === 1) return [{label: `The project check did not pass: ${counted(diagnostics.length)}`}, ...errors];
  return [...errors, ...diagnostics.length ? [{label: counted(diagnostics.length)}] : []];
}

export function parseColumns(stdout: string, exit: number | null): Node[] {
  try {
    return relations(JSON.parse(stdout), exit);
  } catch (error) {
    const reason = error instanceof Unreadable ? error.message : error instanceof SyntaxError ? 'the output is not JSON' : undefined;
    if (reason === undefined) throw error;
    return [{label: `The extension cannot read the column view of this Pietto: ${shown(reason)}.`}];
  }
}

// The columns of a saved project, as the project preview runs Pietto: the same output limit
// and deadline, and any error output fails the run. A cancelled run has no result.
export async function relationColumns(python: string, launcher: string[], root: string, token: Cancellation): Promise<Node[] | undefined> {
  const ran = await run(python, explainArguments(launcher, root), 'explain --project', 64 * 1024 * 1024, 60_000, token);
  if (ran.status === 'cancelled') return undefined;
  if (ran.status === 'failed') return [{label: shown(ran.message)}];
  // No exit code: the interpreter was not found, or a signal stopped it.
  return ran.exit === null ? [{label: 'Pietto explain --project stopped before it completed.'}] : parseColumns(ran.stdout, ran.exit);
}
