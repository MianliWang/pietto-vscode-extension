# Architecture

The extension is declarative language support plus one language client.

| Part | Owner | Needs Workspace Trust |
| --- | --- | --- |
| Highlighting | `syntaxes/pietto.tmLanguage.json` (TextMate) | no |
| Snippets | `snippets/pietto.json` | no |
| Comments, brackets, indentation, folding | `language-configuration.json` (folding is VS Code's indentation folding with `folding.offSide`) | no |
| Diagnostics | `pietto lsp`, through `vscode-languageclient` | yes |

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
- Restarts: a change of `pietto.pythonPath`, `pietto.pythonArguments` or
  `pietto.projectRoots`, a change of workspace folders, granting trust, and
  **Pietto: Restart Language Server** stop the client and start a new one.
  Restarts run one at a time, and each waits at most 30 s for the server to
  answer `initialize`, so a server that never answers cannot hold back the
  next restart. Stopping sends `shutdown` and `exit`, then kills the process
  if it is still there.
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

The server re-reads a project root only on a document event inside it, so
the README asks for **Pietto: Restart Language Server** after an edit of
`pietto.toml` or of modules outside the editor.

## Windows desktop with a WSL interpreter

When `pietto.pythonPath` is `wsl.exe` on Windows, `src/launch.ts` maps drive
paths to `/mnt/<drive>/…` for the project roots and, through the client's
`uriConverters`, for document URIs in both directions. Other paths are passed
unchanged, so projects on the WSL file system are for Remote WSL, where the
extension runs inside WSL (`extensionKind: workspace`) and needs no mapping.

## Trust

`capabilities.untrustedWorkspaces` is `limited`. In Restricted Mode the
extension starts no process and ignores `pietto.pythonPath` and
`pietto.pythonArguments` from the workspace (`restrictedConfigurations`).
Highlighting, snippets and folding work.

## What the extension does not do

No hover, completion, definition, outline, formatter, SQL, tree views,
connection configuration, telemetry, source upload or automatic installation.
The adapter of 0.1.0 and 0.1.1 that provided hover, completion, definition,
outline and the model and connection views imported private Pietto modules, so
it was removed; those features return only on public Pietto contracts.
