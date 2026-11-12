# Architecture

The extension is declarative language support plus one language client.

| Part | Owner | Needs Workspace Trust |
| --- | --- | --- |
| Highlighting | `syntaxes/pietto.tmLanguage.json` (TextMate) | no |
| Snippets | `snippets/pietto.json` | no |
| Comments, brackets, indentation, folding | `language-configuration.json` (folding is VS Code's indentation folding with `folding.offSide`) | no |
| Diagnostics | `pietto lsp`, through `vscode-languageclient` | yes |
| Hover, definition and document symbols | Standard LSP from `pietto lsp`, through `vscode-languageclient` | yes |
| Single-file SQL preview | `pietto emit-sql FILE --dialect {postgres,mysql} --format json` | yes |
| Project SQL preview | `pietto emit-sql --project ROOT --all --module MODULE --dialect {postgres,mysql} --emission-contract FILE --format json` | yes |
| Pietto Models view | `src/models.ts` on `pietto explain --project ROOT --format json` (`pietto.project-relation-columns.v1`, alpha) | yes |
| Target diagnostics (opt-in) | `src/target.ts`: after a save, `pietto emit-sql --project ROOT --all --dialect {postgres,mysql} --emission-contract FILE --format json`, or `pietto emit-sql FILE --dialect {postgres,mysql} --format json` outside every root | yes |
| Quick fixes | `src/actions.ts` on the public diagnostic codes `PIE-S2708` and `PIE-P1000`; the migration preview runs `pietto migrate FILE` | yes |

## Grammar and snippets

`syntaxes/pietto.tmLanguage.json` (scope `source.pietto`) follows Pietto's
`grammar/Pietto.g4`. Each top-level declaration is a block that lasts while
its lines are indented, so field rules apply only in shapes and clause rules
only in relation bodies. Pietto lets most keywords be names, so a clause word
is a keyword only where its clause follows on the same line, and frame words
only together with their bound; retired header lines (`pietto 0.9`, `mode`,
`dialect`, `encoding`) get no keyword scope. The grammar is the source of
truth; `tests/sync_language.py` only writes test fixtures from extracted
Pietto trees: `tests/fixtures/language.json` (the `Pietto.g4` keywords, the
names they may spell, and the built-in types, functions, aggregates and window
functions of Pietto's semantic catalogs) and `tests/fixtures/corpus.json` (the
`pietto` code blocks of Pietto's docs and its examples, with the keyword roles
and literal spans from Pietto's own lexer and parser). The tests hold the
grammar's word lists equal to that snapshot and every corpus keyword, name,
string, number and comment to its scope. One built-in call is outside the
catalogs and has its own rule: `unnest(`, as in an Unnest let
`let o = unnest(p.field)`. The snippets use the canonical forms
of Pietto's `docs/style.md`; each must pass `pietto check` and
`pietto fmt --check` (run with `PIETTO_TEST_PYTHON`).

## Language client

`src/extension.ts` creates one `LanguageClient` per window with the official
`vscode-languageclient` package, pinned to **9.0.1**: it is the newest release
whose `engines.vscode` (`^1.82.0`) accepts this extension's `^1.90.0`; every
10.x and 11.x release requires `^1.91.0`. It ships in the VSIX with its
dependencies (`vscode-languageserver-protocol` 3.17.5, `vscode-jsonrpc` 8.2.0,
`vscode-languageserver-types` 3.17.5, `semver`, `minimatch`); none has an
install script.

- Transport: stdio. The extension spawns the server itself, without a shell
  and with `windowsHide`, and hands the process to the client.
- Command: `pietto.pythonPath`, then `pietto.pythonArguments`, then
  `-I -c "import sys; from pietto.cli import main; sys.exit(main(['lsp']))"`.
  `pietto.cli:main` is the target of Pietto's `pietto` console script; Pietto
  has no `python -m pietto`. `-I` keeps the working directory, user
  site-packages and `PYTHON*` variables out of the import path. The script has
  no double quote, `$`, backtick or backslash, so it survives a `wsl.exe --`
  launcher that passes it to a shell.
- Documents: `file` and `untitled` documents with language `pietto`, full
  sync, as `pietto lsp` requires. Diagnostics go to the `pietto` collection
  with the server's `code`, `message`, `range` and `severity`.
- Initialization: `{"projectRoots": [...]}`. Each workspace folder's
  `pietto.projectRoots` entries resolve against that folder; duplicates are
  dropped (the server refuses them), and the first spelling is kept.
- Restarts: a change of any `pietto.*` setting (`pietto.pythonPath`,
  `pietto.pythonArguments`, `pietto.projectRoots`, and also the preview
  settings `pietto.sqlDialect` and `pietto.emissionContract` and
  `pietto.targetDiagnostics`), a
  `pietto.toml` created, changed or deleted under a selected root, a change
  of workspace folders, granting trust, and **Pietto: Restart Language
  Server** stop the client and
  start a new one. The settings and `pietto.toml` triggers are debounced: one
  restart runs 500 ms after the last of a burst, and the other triggers run
  at once and drop a pending one. Restarts run one at a time, and each waits
  at most 30 s for the server to answer `initialize`, so a server that never
  answers cannot hold back the next restart. Stopping sends `shutdown` and
  `exit`, then kills the process if it is still there.
- Settings are read defensively: a list setting that holds anything but a list
  counts as empty, and only its strings are used.

## Failure handling

Before each start the extension runs `pietto lsp --help` through the same
command, with a 60 s limit. It exits 0 only where the `lsp` subcommand exists.
Otherwise the extension shows one error message with the last line of the
interpreter's error output (decoded as UTF-16LE when it holds NUL bytes, as
the errors of `wsl.exe` do), or with Node's error when the interpreter cannot
be started at all, such as an empty `pietto.pythonPath`, and starts nothing;
the next attempt is the next restart trigger. This avoids the client's crash
loop and its generic "couldn't create connection" messages for the common
cases: no interpreter, no pietto, a pietto older than 0.1.10. A server that
has not answered `initialize` 30 s after it starts gets one error message as
well and is replaced by the next restart. A server that exits after a
successful start is restarted by the client's default handler, at most four
times in three minutes.

The server re-reads a project root only on a document event inside it and
does not watch the disk. Each start therefore creates one file system watcher
per resolved root, `RelativePattern(root, '**/pietto.toml')`, so roots outside
the workspace folders are watched too; its create, change and delete events
schedule the debounced restart, and stopping disposes the watchers. A start
that the probe refuses creates none, so no restart loop follows. Modules
changed outside the editor are not watched, so the README asks for **Pietto:
Restart Language Server** after such a change; a core watched-files contract
is a later decision.

## Editor navigation

The client uses the standard LSP hover, definition and document-symbol
capabilities that a compatible Pietto server advertises; it has no private
provider, core import or editor-facts transport. Pietto answers each request
from an ephemeral snapshot made by the same analysis that produced the current
diagnostics. A document edit, close, root or URI conflict, or failed analysis
invalidates that snapshot. In those cases, and for unknown or ambiguous
bindings, the server returns no hover or definition and no symbols.

Definition returns a target location only for an exact retained `type` or
`from` target. Hover exposes retained declaration and type text, including a
known builtin type; document symbols list named top-level declarations in
source order. The request itself does not parse, check, compile or read the
document. Fields, lets, parameters, function calls, completion and formatting
remain outside this contract.

## SQL preview

The three preview commands accept only a saved, unchanged file document. Each
runs the selected interpreter with `-I` and the public `emit-sql` command in a
separate argv array, rather than embedding paths in Python code. On Windows
with a `wsl.exe` launcher, the file and root paths use the existing `/mnt`
conversion. The dialect is a command argument `{"dialect": ...}`, else the
resource setting `pietto.sqlDialect` (`postgres` or `mysql`); **Pietto:
Preview PostgreSQL SQL (Single File)** fixes it to `postgres`. An unexpected
stderr stream, invalid JSON, a response other than the expected one, timeout,
cancellation, document edit or close, `pietto.*` setting change, or a
superseding preview opens no result. An interpreter that cannot be started at
all gives an error message with Node's cause. Parsers read only the fields
they show and ignore the others, so an additive Pietto field changes nothing;
an unknown `schema_version` or `format` is refused.

Single file: `emit-sql FILE --dialect DIALECT --format json` (CLI JSON v1).
The response must be a v1 `emit-sql` envelope of that dialect for that exact
input path. Multiple artifacts are offered in compiler order.

Project: `emit-sql --project=ROOT --all --module=MODULE --dialect=DIALECT
--emission-contract=CONTRACT --format=json`, the documented batch form
narrowed to the active module. Each value is joined to its option with `=`, so
a path that starts with `-` stays a value. `ROOT` is the one entry of
`pietto.projectRoots` that contains the file (none or two are refused before
Pietto runs), `MODULE` the file's root-relative path with `/` separators, and
`CONTRACT` the argument `{"emissionContract": ...}`, else the resource setting
`pietto.emissionContract`, passed unchanged; Pietto itself reads it under its
pinned-root rules. Pietto compiles the project from disk, so any unsaved file
of the root refuses the preview, and a change or save of one while Pietto runs
makes the result stale. The response must be a `pietto.sql-emission.batch.v1`
document whose exit code is the one its status documents (0, 1 or 2), whose
status is its failure document's or else the one its items derive (any
`INPUT_REJECTED`, else any `BLOCKED`, else `VERIFIED`), whose items name the
requested module, and whose `VERIFIED` items have the requested target family.
Items are `pietto.sql-emission.v1` or `v2` documents and are offered in batch
(project authority) order with their status. A `VERIFIED` item opens its exact
`sql`; a `BLOCKED` or `INPUT_REJECTED` item, and a whole-batch `BLOCKED`
failure document, open as a plain-text report: a heading line naming the
owner or module and the dialect, then exactly the lines that
`--format text` writes to stderr for that document (pietto 0.1.10's failure
presentation). These are the `format status` line; each CLI error as
`error KIND: MESSAGE` with ` (path: PATH)` when it has one; each blocker as
`blocker CODE REASON: DETAIL` with ` (PATH:LINE:COLUMN)` when it is located,
then `  related: ...` for its located related locations and `  hint: ...`; and
each diagnostic as `PATH:LINE:COLUMN CODE SEVERITY: MESSAGE`. Every value is
escaped as Pietto escapes text (C0 controls and DEL as `\xNN`; C1, separator
and bidi controls as `\uNNNN`), so each entry stays on one line. The
real-CLI test compares the report with Pietto's own text output. A
whole-batch `INPUT_REJECTED` document is shown as a message of the same
lines. The output limit is Pietto's 64 MiB batch limit and the deadline 60
seconds, against 4 MiB and 30 seconds for one file.

Every virtual document is read-only and holds exactly one artifact's SQL or
one report. The previews never write a source file, execute SQL, format a
buffer, choose a project root or contract, or call private core APIs.

## Pietto Models

A tree view in the Explorer, `pietto.models`, shown once a Pietto document
has activated the extension. Its top-level nodes are the resolved roots of
`pietto.projectRoots`; with none, its welcome content offers
`pietto.selectProject`. There is no single-file view.

Each root runs `explain --project=ROOT --format=json` exactly as the project
preview runs Pietto: the selected interpreter with `-I`, the value joined to
its option, the `/mnt` mapping for a `wsl.exe` launcher, the 64 MiB output
limit and the 60 s deadline, and any error output fails the run. The column
view reads the project from disk, so the root node says `shows the saved
files` while one of its files is unsaved.

`src/models.ts` reads the document strictly and never shows part of one:

- `format` must be `pietto.project-relation-columns.v1`, or
  `pietto.project-explain.v1`, which a `schema_version = 4` project answers
  (one line: the view does not apply) and which carries configuration and
  root failures (one `project error: CODE: MESSAGE` line each). Any other
  format is refused.
- The exit code must be the one `ok` documents: 0 for `true`, 1 or 2 for
  `false`. With `ok` true, `relations` is listed and `cli_errors` must be
  empty; with `ok` false, `relations` must be `null`, and the root shows each
  CLI error as `project error: KIND: MESSAGE` and the number of diagnostics,
  which the language server already shows in Problems.
- Relations keep the document order and identity: `kind name` with the
  module as description, nothing merged, sorted or dropped. A column is
  `name: Type` with its nullability verbatim; `enum` and `shape` add their
  declaring module, `type_alias` and `unknown` their kind, and a `collection`
  lists its element columns, which must not be collections.
- An unknown relation kind, type kind or nullability, a missing or mistyped
  field it reads, invalid JSON, an exit code that disagrees with `ok`, error
  output, or output over the limit replaces the root's children with one line
  that names the reason. Fields it does not read are ignored.
- Every name, path and message is escaped as the previews escape text. Tree
  items use plain-text labels and descriptions; nothing is a Markdown or
  command link, and a node does not navigate, because the column view has no
  source locations.

Runs happen only while the view is visible and the workspace is trusted: when
the view becomes visible, on **Pietto: Refresh Models**, on a change of any
`pietto.*` setting, of workspace folders or of trust, and 500 ms after the
last save of a `.pietto` file or `pietto.toml` inside a root. A save stops the
root's running `explain` at once and drops its result. A root has at most one
`explain` process: each new run first cancels the previous one and starts
only after its process has exited; a run that a newer trigger replaced shows
nothing. A cancelled or timed-out run of a preview or of the view counts as
ended only once its process has exited. A hidden view keeps its last result
and lists every root again when it becomes visible.

## Target diagnostics

An interim extension feature: `pietto lsp` publishes `pietto check`
diagnostics only, and Pietto's decisions D75.09 and ED.06 keep backend
refusals out of the server and leave target readiness in the editor to the
extension for now. With the resource setting
`pietto.targetDiagnostics` (default `false`), a save runs `emit-sql` and puts
what it refuses into a second collection, `pietto-target`, as Warnings with
the source `pietto emit-sql (DIALECT)`, so the quick fixes, which read only
source `pietto`, never act on them. The server and its contract are
unchanged.

- Scopes: a save of a file of the `file` scheme schedules each scope it
  belongs to: every root of `pietto.projectRoots` that holds it as a `pietto`
  document, its `pietto.toml` or its `pietto.emissionContract`, else, for a
  `pietto` document outside every root, the file itself. A root runs
  `emit-sql --project=ROOT --all --dialect=DIALECT --emission-contract=CONTRACT
  --format=json`, the preview's batch form without `--module`, with 64 MiB and
  60 s; a file runs the single-file preview's command with 4 MiB and 30 s.
  Both go through `run()` of `src/preview.ts`: `-I`, an argv array, no shell,
  the `/mnt` mapping of a `wsl.exe` launcher, and any stderr counts as a
  failure. Nothing runs without Workspace Trust, with the setting off, with a
  dialect other than `postgres` or `mysql`, for a root without a contract, or
  while any file of the scope is unsaved.
- Freshness: each scope is debounced by 500 ms after its last save and runs
  one process at a time; a new run cancels the old one. An edit of a file of
  the scope cancels its timer and run and clears its entries; closing a file
  outside every root clears its own. A change of any `pietto.*` setting or of
  the workspace folders clears every scope. A result is shown only if its run
  is still the scope's current one after the files it names are read, so a
  stale result is dropped. Each file shows the entries of every scope that
  names it, in scope order.
- Reading: the single-file response must be a CLI JSON v1 `emit-sql`
  envelope of that dialect for that input path, whose `ok` and exit code are
  the ones its `cli_errors` and error diagnostics give. The batch is read by
  the preview's `parseBatch` (exit code, status and items agree), with every
  module a normalized relative path and every `VERIFIED` item of the dialect.
  Each document that is not `VERIFIED` gives, in document order, its CLI
  errors except the project loading kinds that `pietto lsp` reports itself
  (`project_root`, `config_read`, `config_parse`, `config_schema`,
  `project_path`, `project_glob`, `project_resource`, `source_read`), then its
  `PIE-B` blockers and its `PIE-B` diagnostics. A document with an error
  diagnostic that is not `PIE-B` gives nothing (the check errors are the
  server's; `PIE-I` is not shown in this version); warnings do not count. An
  item's entries start with `KIND NAME: `. A blocker reads
  `REASON: DETAIL` with its suggestion on a second line; a diagnostic reads as
  `pietto lsp` shows one; a CLI error reads `KIND: MESSAGE` with
  ` (path: PATH)` when it has one, escaped as the preview report escapes
  text. Every entry is kept: no deduplication and no winner.
- Places: a located entry and its located related items keep their
  positions, converted as `pietto lsp` converts those of a closed disk file:
  one-based code-point columns to UTF-16, a leading BOM not counted, LF, CRLF
  and CR as line breaks, a missing end as the start, and clamped at the last
  position. An entry without a location goes to the start of its item's
  module; of a whole-batch document, a contract CLI error with a path goes to
  the contract file and everything else to `pietto.toml`; in single-file mode,
  to the file.
- Failures: a response that is not valid JSON, has an unknown `format`,
  `schema_version` or field shape, or disagrees with its exit code, a timeout
  or an interpreter that cannot be started gives one Warning with the reason
  at the start of `pietto.toml` (the file in single-file mode) and no partial
  result.

## Quick fixes

One code action provider for `pietto` documents of the `file` scheme (an
untitled buffer has no project root and no file to migrate) maps the
diagnostics in the requested range to quick fixes in `src/actions.ts`. It reads
only the public diagnostic fields: `source` `pietto`, the `PIE-` code and, for
`PIE-S2708`, the severity, which the diagnostics contract fixes as a Warning
outside a project and an Error in a `schema_version = 1` project, where the fix
is `schema_version = 2` rather than a root. It never reads a message, so an
editor-only message, which has no code, gets no action. All diagnostics of one
fix share one action.

- `PIE-S2708` (Warning): **Select project root** runs the existing
  `pietto.selectProject` command without a target, so the person picks the
  folder and the command writes `pietto.projectRoots`; the settings change
  restarts the server. A file inside a selected root that its `[sources]`
  leaves out gets the same Warning, but choosing that root again writes the
  same value and changes nothing; the README sends that case to `pietto.toml`.
- `PIE-P1000`: **Preview migration (pietto migrate)** runs the internal
  `pietto.previewMigration` command with the document URI. It needs Workspace
  Trust and a saved, unchanged file document, and runs `pietto migrate FILE`
  through the selected interpreter with `-I` and the path as a separate
  argument (mapped to `/mnt` for a `wsl.exe` launcher), with the 30 s and
  4 MiB limits of the single-file SQL preview. `PIE-P1000` is every syntax error, not only
  a retired spelling; for an ordinary one `migrate` fails with the same
  diagnostic. Offering the fix only for retired spellings would need a
  structured core marker, not the message. `migrate` has no JSON form: only
  exit 0 with empty stderr counts as a migration, and its stdout is then the
  whole source; any other exit shows stderr in an error message and never
  stdout. The result opens in `vscode.diff` against the file itself; the
  migrated side is a `pietto-migration-preview` virtual document, read-only,
  with a leading BOM left out as VS Code leaves it out of the file's side. A
  document edit or close, a settings change or a newer SQL or migration
  preview while it runs opens nothing. The command writes no file and applies
  no edit.

## Windows desktop with a WSL interpreter

When `pietto.pythonPath` is `wsl.exe` on Windows, `src/launch.ts` maps drive
paths to `/mnt/<drive>/…` for the project roots and, through the client's
`uriConverters`, for document URIs in both directions. Other paths are passed
unchanged, so projects on the WSL file system are for Remote WSL, where the
extension runs inside WSL (`extensionKind: workspace`) and needs no mapping.

## Trust

`capabilities.untrustedWorkspaces` is `limited`. In Restricted Mode the
extension starts no process, for target diagnostics neither, and ignores `pietto.pythonPath` and
`pietto.pythonArguments` from the workspace (`restrictedConfigurations`).
Highlighting, snippets and folding work. The Pietto Models view shows one line
that asks for trust and runs nothing.

## What the extension does not do

No completion, formatter, connection view or configuration, telemetry,
source upload, automatic installation, or quick fix that edits a Pietto file
or applies a text edit; the one quick fix that writes anything, **Select
project root**, writes only the `pietto.projectRoots` setting of the folder
you pick. The adapter of 0.1.0 and 0.1.1 that provided broader hover,
completion, definition, outline and the model and connection views imported
private Pietto modules, so it remains removed. The current standard-LSP
navigation and the Pietto Models view use only public core contracts; they do
not restore the connection view or broader binding categories.
