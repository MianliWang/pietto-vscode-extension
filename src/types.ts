export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Target { uri: string; range: Range }
export interface Candidate {
  name: string; kind: string; type?: string; nullability?: string;
  definition?: Target; documentation?: string;
}
export interface Field extends Candidate { id?: string; range?: Range; path?: string; lineage?: string[]; origin?: Target }
export interface Symbol {
  id: string; name: string; kind: string; range?: Range; selectionRange?: Range;
  fields?: Field[]; inputFields?: Field[]; provider?: string; state: string;
  physical?: {schema?: string; table: string};
  relationship?: {endpoints: {name: string; relation: string; definition?: Target}[]};
}
export interface Diagnostic {
  code: string; severity: string; message: string; range?: Range;
  related?: (Target & {message: string})[];
}
export interface Observation {
  uri: string; version: number; state: 'checked' | 'parsed' | 'invalid' | 'unavailable';
  diagnostics: Diagnostic[]; symbols: Symbol[];
  occurrences: (Candidate & {range: Range})[];
  contexts: {range: Range; kind: string; items: Candidate[]}[];
}
export interface Compiler { python: string; origin: string; distributionVersion: string; sourceFingerprint: string; reference: string }
export interface Reply { id: number; protocol: number; compiler: Compiler | null; ok: boolean; issues: string[]; documents: Observation[]; elapsedMs: number }
export interface DocumentInput { uri: string; path?: string; text: string; version: number }
export interface Request { id: number; root?: string; documents: DocumentInput[] }
export function contains(range: Range, position: Position): boolean {
  const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return before(range.start, position) && before(position, range.end);
}

// Validate the one data boundary before any native provider can see a response.
export function validReply(value: unknown): value is Reply {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const text = (item: unknown) => typeof item === 'string';
  const optionalText = (item: unknown) => item === undefined || text(item);
  const position = (item: unknown): item is Position => record(item) && Number.isInteger(item.line) && Number.isInteger(item.character) && (item.line as number) >= 0 && (item.character as number) >= 0;
  const range = (item: unknown): item is Range => record(item) && position(item.start) && position(item.end) && (item.start.line < item.end.line || (item.start.line === item.end.line && item.start.character <= item.end.character));
  const target = (item: unknown) => record(item) && text(item.uri) && range(item.range);
  const candidate = (item: unknown): item is Record<string, unknown> => record(item) && text(item.name) && text(item.kind) && optionalText(item.type) && optionalText(item.nullability) && optionalText(item.documentation) && (item.definition === undefined || target(item.definition));
  const field = (item: unknown) => candidate(item) && (item.range === undefined || range(item.range)) && optionalText(item.id) && optionalText(item.path) && (item.origin === undefined || target(item.origin)) && (item.lineage === undefined || Array.isArray(item.lineage) && item.lineage.every(text));
  if (!record(value) || value.protocol !== 1 || !Number.isInteger(value.id) || typeof value.ok !== 'boolean' || !Array.isArray(value.issues) || !value.issues.every(text) || !Array.isArray(value.documents) || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) return false;
  if (value.compiler !== null && (!record(value.compiler) || !['python', 'origin', 'distributionVersion', 'sourceFingerprint', 'reference'].every(key => text((value.compiler as Record<string, unknown>)[key])))) return false;
  if (value.compiler === null && value.ok) return false;
  return value.documents.every(doc => record(doc) && text(doc.uri) && Number.isInteger(doc.version) && ['checked', 'parsed', 'invalid', 'unavailable'].includes(doc.state as string)
    && Array.isArray(doc.symbols) && doc.symbols.every(symbol => record(symbol) && text(symbol.id) && text(symbol.name) && text(symbol.kind) && text(symbol.state) && optionalText(symbol.provider) && (symbol.physical === undefined || record(symbol.physical) && optionalText(symbol.physical.schema) && text(symbol.physical.table) && Object.keys(symbol.physical).every(key => ['schema', 'table'].includes(key))) && (symbol.relationship === undefined || record(symbol.relationship) && Array.isArray(symbol.relationship.endpoints) && symbol.relationship.endpoints.every(item => record(item) && text(item.name) && text(item.relation) && (item.definition === undefined || target(item.definition)))) && (symbol.range === undefined || range(symbol.range)) && (symbol.selectionRange === undefined || range(symbol.selectionRange)) && (symbol.fields === undefined || Array.isArray(symbol.fields) && symbol.fields.every(field)) && (symbol.inputFields === undefined || Array.isArray(symbol.inputFields) && symbol.inputFields.every(field)))
    && Array.isArray(doc.occurrences) && doc.occurrences.every(item => candidate(item) && range(item.range))
    && Array.isArray(doc.contexts) && doc.contexts.every(item => record(item) && range(item.range) && text(item.kind) && Array.isArray(item.items) && item.items.every(candidate))
    && Array.isArray(doc.diagnostics) && doc.diagnostics.every(item => record(item) && text(item.code) && text(item.message) && text(item.severity) && (item.range === undefined || range(item.range)) && (item.related === undefined || Array.isArray(item.related) && item.related.every(location => target(location) && record(location) && text(location.message)))));
}
