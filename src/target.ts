import {Dialect, previewArguments, projectTargetArguments, ProjectTarget} from './launch';
import {Cancellation, dialectNames, envelope, isRecord, parseBatch, run, sameDialect, shown, Stopped} from './preview';

// Target diagnostics: what `pietto emit-sql` refuses for the selected dialect, from the saved
// files. pietto lsp already shows the check diagnostics, so only PIE-B refusals and the CLI
// errors that pietto lsp does not report itself are shown here.

// A one-based Pietto position in characters, and its exclusive end (null when unknown).
export interface Location {readonly line: number; readonly column: number; readonly endLine: number | null; readonly endColumn: number | null}

// One problem in `path`, a project-relative path, or null for the file itself in single-file
// mode and for the root's pietto.toml in a project. Without a location it is shown at the
// start of that file.
export interface Problem {
  readonly path: string | null;
  readonly location: Location | null;
  readonly code?: string;
  readonly message: string;
  readonly related: {readonly path: string | null; readonly location: Location}[];
}

export type TargetResult = {readonly status: 'ready'; readonly problems: Problem[]} | Stopped;

// The CLI error kinds of a project load, which pietto lsp reports from check --project.
const lspKinds: readonly unknown[] = ['project_root', 'config_read', 'config_parse', 'config_schema', 'project_path', 'project_glob', 'project_resource', 'source_read'];
const severities: readonly unknown[] = ['error', 'warning', 'info'];
const isPosition = (value: unknown) => Number.isInteger(value) && (value as number) >= 1;
// A normalized project-relative path, as Pietto writes module paths.
const isRelative = (value: unknown): value is string => typeof value === 'string' && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

// Where the problems of one document go. `source`: single-file mode, whose locations name that
// file. `home`: where a problem without a usable location goes (an owner's module, else null).
// `contract`: where a whole-batch emission_* CLI error with a path goes.
interface Place {readonly source?: string; readonly prefix: string; readonly home: string | null; readonly contract?: string}
type Located = {readonly path: string | null; readonly location: Location};

// A document location; null for none and, in a project, for one without a path; undefined for
// an unknown shape.
function locate(value: unknown, {source}: Place): Located | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isPosition(value.line) || !isPosition(value.column)
    || !(value.end_line === null || isPosition(value.end_line)) || !(value.end_column === null || isPosition(value.end_column))) return undefined;
  const location = {line: value.line as number, column: value.column as number, endLine: value.end_line as number | null, endColumn: value.end_column as number | null};
  if (source !== undefined) return value.path === null || value.path === source ? {path: null, location} : undefined;
  return value.path === null ? null : isRelative(value.path) ? {path: value.path, location} : undefined;
}

// The problems of one emission document: each CLI error that pietto lsp does not report, then
// each PIE-B blocker and diagnostic, in document order. An error diagnostic that is not PIE-B
// (a check error, which pietto lsp shows, or an IR error) leaves the whole document out; a
// warning does not. undefined: a field it reads has an unknown shape.
function problemsOf(document: Record<string, unknown>, place: Place): Problem[] | undefined {
  const [errors, blockers, diagnostics] = ['cli_errors', 'blockers', 'diagnostics'].map(key => document[key] ?? []);
  if (!Array.isArray(errors) || !Array.isArray(blockers) || !Array.isArray(diagnostics)) return undefined;
  const at = (located: Located | null) => located ?? {path: place.home, location: null};
  const found: Problem[] = [];
  let checkError = false;
  for (const error of errors) {
    if (!isRecord(error) || typeof error.kind !== 'string' || typeof error.message !== 'string' || (typeof error.path !== 'string' && error.path !== null)) return undefined;
    if (lspKinds.includes(error.kind)) continue;
    found.push({path: error.kind.startsWith('emission_') && error.path !== null && place.contract !== undefined ? place.contract : place.home, location: null, related: [],
      message: `${place.prefix}${shown(error.kind)}: ${shown(error.message)}${error.path === null ? '' : ` (path: ${shown(error.path)})`}`});
  }
  for (const blocker of blockers) {
    const location = isRecord(blocker) ? locate(blocker.location, place) : undefined;
    const related = isRecord(blocker) && Array.isArray(blocker.related) ? blocker.related.map(item => locate(item, place)) : [undefined];
    if (!isRecord(blocker) || location === undefined || related.includes(undefined) || typeof blocker.code !== 'string' || typeof blocker.reason !== 'string'
      || !isRecord(blocker.subject) || typeof blocker.suggestion !== 'string') return undefined;
    if (!blocker.code.startsWith('PIE-B')) continue;
    found.push({...at(location), code: blocker.code, related: related.filter((item): item is Located => !!item),
      message: `${place.prefix}${shown(blocker.reason)}: ${shown(blocker.subject.detail)}\n${shown(blocker.suggestion)}`});
  }
  for (const diagnostic of diagnostics) {
    const location = isRecord(diagnostic) ? locate(diagnostic.location, place) : undefined;
    if (!isRecord(diagnostic) || location === undefined || typeof diagnostic.code !== 'string' || !severities.includes(diagnostic.severity)
      || typeof diagnostic.message !== 'string' || (typeof diagnostic.suggestion !== 'string' && diagnostic.suggestion !== null)) return undefined;
    if (!diagnostic.code.startsWith('PIE-B')) {
      checkError ||= diagnostic.severity === 'error';
      continue;
    }
    // As pietto lsp shows it: a suggestion that the message does not hold follows on a second line.
    const hint = diagnostic.suggestion === null || diagnostic.message.includes(diagnostic.suggestion) ? '' : `\n${diagnostic.suggestion}`;
    found.push({...at(location), code: diagnostic.code, related: [], message: `${place.prefix}${diagnostic.message}${hint}`});
  }
  return checkError ? [] : found;
}

// The CLI JSON v1 envelope of `emit-sql FILE`, for exactly that file.
export function parseFileTargets(stdout: string, exit: number | null, dialect: Dialect, source: string): TargetResult {
  const what = `${dialectNames[dialect]} target diagnostics`;
  const parsed = envelope(stdout, dialect, what);
  if (parsed.status === 'failed') return parsed;
  const {value} = parsed;
  // CLI JSON v1: exit 2 for a CLI error, else 1 for an error diagnostic, else 0, the one exit with ok.
  const expected = value.cli_errors.length ? 2 : value.diagnostics.some(item => isRecord(item) && item.severity === 'error') ? 1 : 0;
  const problems = value.path === source && value.ok === (expected === 0) ? problemsOf(value, {source, prefix: '', home: null}) : undefined;
  if (!problems) return {status: 'failed', message: 'Pietto returned an unsupported emit-sql JSON response.'};
  return exit === expected ? {status: 'ready', problems} : {status: 'failed', message: `Pietto stopped before ${what} completed.`};
}

// The pietto.sql-emission.batch.v1 document of a root. A whole-batch failure document goes to
// pietto.toml (or the contract); each item that is not VERIFIED goes to its owner's module,
// named in each message.
export function parseProjectTargets(stdout: string, exit: number | null, dialect: Dialect, contract: string): TargetResult {
  const unsupported = {status: 'failed', message: 'Pietto returned an unsupported project emit-sql JSON response.'} as const;
  const batch = parseBatch(stdout, exit, `project ${dialectNames[dialect]} target diagnostics`);
  if (batch.status === 'failed') return batch;
  if (!batch.items.every(item => isRelative(item.owner.module) && sameDialect(item, dialect))) return unsupported;
  const documents = batch.failure ? [problemsOf(batch.failure.fields, {prefix: '', home: null, contract})]
    : batch.items.filter(item => item.status !== 'VERIFIED').map(({owner, fields}) => problemsOf(fields, {prefix: `${shown(owner.kind)} ${shown(owner.name)}: `, home: owner.module}));
  return documents.every((found): found is Problem[] => found !== undefined) ? {status: 'ready', problems: documents.flat()} : unsupported;
}

// `emit-sql FILE`, with the limits of the single-file SQL preview.
export async function fileTargets(python: string, launcher: string[], source: string, dialect: Dialect, token: Cancellation): Promise<TargetResult> {
  const ran = await run(python, previewArguments(launcher, [source], dialect), `${dialectNames[dialect]} target diagnostics`, 4 * 1024 * 1024, 30_000, token);
  return ran.status === 'done' ? parseFileTargets(ran.stdout, ran.exit, dialect, source) : ran;
}

// The batch over the whole root, with the limits of the project SQL preview.
export async function projectTargets(python: string, launcher: string[], request: ProjectTarget, token: Cancellation): Promise<TargetResult> {
  const ran = await run(python, projectTargetArguments(launcher, request), `project ${dialectNames[request.dialect]} target diagnostics`, 64 * 1024 * 1024, 60_000, token);
  return ran.status === 'done' ? parseProjectTargets(ran.stdout, ran.exit, request.dialect, request.contract) : ran;
}

// The lines of a saved file as Pietto counts them: a leading BOM is not counted, and LF, CRLF
// and a lone CR each end a line.
export const sourceLines = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

// A location as a zero-based UTF-16 range, converted as pietto lsp converts it: a line past the
// end is the end of the last line, a missing end is the start, and no location is the start of
// the file.
export function range(lines: string[], location: Location | null): [number, number, number, number] {
  const point = (line: number, column: number): [number, number] => line > lines.length
    ? [lines.length - 1, lines[lines.length - 1].length]
    : [line - 1, Array.from(lines[line - 1]).slice(0, column - 1).join('').length];
  if (!location) return [0, 0, 0, 0];
  const start = point(location.line, location.column);
  return [...start, ...(location.endLine === null || location.endColumn === null ? start : point(location.endLine, location.endColumn))];
}
