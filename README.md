![Pietto: a query language for analytical thinking](images/pietto-readme-banner.png)

# Pietto for VS Code

Highlighting, snippets and folding for `.pietto` files, and Problems
diagnostics from the Pietto language server, `pietto lsp`. With pietto 0.1.11
the server also gives hover, go to definition, symbols, import links,
formatting and completion. The extension starts `pietto lsp` from a Python
environment that you choose. It never installs anything, runs queries, or
connects to a database.

## Install Pietto

The extension needs `pietto lsp`, which first ships in **pietto 0.1.10**.
That is the minimum, and it gives diagnostics. The
[editor features](#editor-features-pietto-0111) (hover, go to definition,
symbols, import links, formatting and completion) need **pietto 0.1.11**.
Install pietto from PyPI, in its own virtual environment of Python 3.12 or
later; the commands below install the newest release:

```bash
python3 -m venv ~/.venvs/pietto
~/.venvs/pietto/bin/python -m pip install "pietto>=0.1.10"
~/.venvs/pietto/bin/pietto lsp --help    # prints "usage: pietto lsp"
```

On Windows:

```powershell
py -3.12 -m venv $HOME\.venvs\pietto
~\.venvs\pietto\Scripts\python.exe -m pip install "pietto>=0.1.10"
~\.venvs\pietto\Scripts\pietto.exe lsp --help    # prints "usage: pietto lsp"
```

## Install the extension

Install **Pietto** (`MianliWang.pietto-vscode-extension`) from the Visual
Studio Marketplace. To run a local build instead, build the VSIX (see
[Develop and verify](#develop-and-verify)) and install
`artifacts/pietto-vscode-extension-0.4.0.vsix` with **Extensions: Install from
VSIX…**.

## Select the interpreter

Run **Pietto: Select Python Interpreter** and enter the absolute path of that
environment's Python, for example `/home/ada/.venvs/pietto/bin/python`. It is
stored in the workspace settings as `pietto.pythonPath`; in a window without a
folder it lasts for the session.

The extension then runs, without a shell:

```text
<pietto.pythonPath> <pietto.pythonArguments...> -I -c "import sys; from pietto.cli import main; sys.exit(main(['lsp']))"
```

That is the `pietto` console command, run in isolated mode (`-I`), so the
working directory, user site-packages and `PYTHON*` variables cannot change
which Pietto runs. Changing `pietto.pythonPath`, `pietto.pythonArguments` or
any other `pietto.*` setting restarts the server, half a second after the last
change.

Before it starts the server, the extension runs `pietto lsp --help` the same
way. If that fails (no pietto, a pietto older than 0.1.10, a wrong path), you
get one error message with the cause, for example
`ModuleNotFoundError: No module named 'pietto'`, and no server is started or
retried until you change a setting or run **Pietto: Restart Language Server**.
A server that has not answered 30 seconds after it starts gets a message too,
and the next restart replaces it. A server that stops after a good start is
restarted at most four times in three minutes. The server's own output is in
**Output › Pietto**.

## Select the project root

Pietto never guesses a project root. Run **Pietto: Select Explicit Project
Root** and choose the folder that holds `pietto.toml`: a workspace folder or a
folder inside one. It is stored in that workspace folder's settings:

```json
{ "pietto.projectRoots": ["project"] }
```

Relative paths resolve against the workspace folder, and absolute paths are
accepted. Each root is the same as `pietto check --project ROOT`. You may list
several roots by editing the setting. **Pietto: Use Single File Mode** sets the
list to `[]`, so that every open file is checked on its own, as
`pietto check FILE` does. Changing the roots restarts the server.

The server checks a root again when a Pietto file inside it is opened, edited
or closed. A `pietto.toml` created, changed or deleted inside a selected root,
in the editor or outside it, restarts the server half a second after the last
such change. Modules changed outside the editor (for example by
`git checkout`) are not watched: run **Pietto: Restart Language Server** after
such a change.

Open [examples/project](examples/project), select it as the root, and open
`models/emails.pietto`: it imports from `models/facade.pietto`, which re-exports
`models/users.pietto`, and the Problems panel stays empty. Import paths are
relative to the project root, such as `"models/users.pietto"`.

## Diagnostics

The Problems panel shows what `pietto check` reports, as the server contract
([Pietto docs/editor-lsp.md](https://github.com/MianliWang/pietto/blob/v0.1.11/docs/editor-lsp.md))
describes:

- Every module that a project root selects is checked, open or not, and gets
  the diagnostics of `pietto check --project ROOT --format json`. An open file
  is checked from its unsaved buffer; nothing is written to disk.
- Every other open file, and an untitled Pietto buffer, is checked like
  `pietto check FILE`. A file that imports from another module reports the
  import as `PIE-S2708` until its project root is in `pietto.projectRoots`.
- Each `pietto check` diagnostic has its code (`PIE-…`), message (a
  suggestion follows on a second line), range and severity (Error, Warning or
  Information).
- A module left out because a module it imports has errors gets an
  Information entry at its import:
  `Not checked: this module imports <file>, which has errors.`
- Project errors read `project error: <kind>: <message>`, at the file they
  name, else at `pietto.toml`, else in a message window.
- The language server reports no backend refusals (`PIE-B…`): it runs no SQL
  dialect. The opt-in [target diagnostics](#target-diagnostics) show them
  after a save.

The server adds these editor-only messages, without a `PIE-` code, at the start
of the file:

| When | Message |
|---|---|
| Two project roots select the same file | `This file belongs to two project roots: <root 1> and <root 2>. Keep one of them in projectRoots.` |
| A selected file is open under two URIs | `This file is open under two URIs: <uri 1> and <uri 2>. Keep one of them open.` |
| Two selected files differ only in letter case | `This file is selected under two names that differ only in letter case: <name 1> and <name 2>. Rename one of them.` |
| The editor sent a partial change | `Pietto needs whole-document changes; reopen this file.` |

Run one Pietto diagnostics source per file; if another tool already runs
`pietto check` on save, turn it off.

## Editor features (pietto 0.1.11)

Each feature below needs **pietto 0.1.11** or later. The extension turns on
whatever the server announces when it starts, without looking at its version.
pietto 0.1.10 announces diagnostics only, so with it these features are absent
and nothing reports an error. The server's
[editor-lsp.md](https://github.com/MianliWang/pietto/blob/v0.1.11/docs/editor-lsp.md)
describes each of them exactly; the surface is alpha and may change in a later
pietto release.

- **Hover and go to definition** cover a shape field's type, a `type`
  alias's base type and a `from` reference, following imports and re-exports
  in a `schema_version = 2` project root. What else they cover depends on
  the mode. In single file mode: the field reads of a relation with a JOIN,
  and relationship calls. In a module of a project root: the field and `let`
  reads of the `let` values, `select` items and `where` of a relation
  without a JOIN, and a `from` that reads a relation `let`. A builtin type,
  and a field of a relation `let`, has a hover but no definition. Other uses
  have neither, such as the reads of a relation without a JOIN and `let`
  uses in single file mode, a JOIN relation's reads, relationship calls and
  a `from` that reads a table function in a project, and in both a
  `source`'s or a parameter's type, `def` calls and parameters.
- **Outline** (document symbols) lists the named top-level declarations of
  the file in source order.
- **Go to Symbol in Workspace** searches those declarations in every module
  of the roots in `pietto.projectRoots`, open or not, and in the other open
  Pietto files. In single file mode (no roots) it searches only the open
  files.
- **Import links**: in a module of a `schema_version = 2` project root, the
  path of each import is a link to the module it names. A file checked on its
  own has none.
- **Format Document** formats the editor's text as `pietto fmt` formats a
  file. It writes nothing until you save and ignores the tab and indentation
  options, because `pietto fmt` has one layout. A file that `pietto fmt`
  refuses, such as one with a syntax error, gets no change.
- **Completion** offers one list everywhere in a file: Pietto keywords, the
  builtin types, functions and aggregates, and the names that the open file
  writes outside comments and strings, except the word you are typing. It
  reads no other file. In Pietto files the list replaces VS Code's word-based
  suggestions, so words that only other open files write are not offered. The
  extension's snippets stay, so a word such as `shape` appears as a keyword
  and as a snippet.

These features read the analysis behind the diagnostics: a module with errors
of its own, a module of a `schema_version = 1` root, or a file that shows one
of the editor-only messages above gets no hover, definition, symbols or links
until that is fixed. Formatting and completion read only the editor's text.

### Format on save

The extension does not format on save by default, so no file is rewritten
without your choice. To format each Pietto file when you save it, add this to
your user or workspace `settings.json`:

```json
{
  "[pietto]": {
    "editor.formatOnSave": true
  }
}
```

A file that `pietto fmt` refuses is then saved as you typed it. The layout of
`pietto fmt` may still change in a later pietto release, which can reformat
files that were formatted before.

## Preview SQL

The preview commands open SQL that Pietto emits in a read-only editor. They
run the public `pietto emit-sql` command through the selected interpreter and
read only files saved on disk, so they refuse an unsaved buffer. They never
save or write a source file, execute SQL or connect to a database. A result
that goes stale while Pietto runs (the file changes or closes, for a project
preview any file of its root changes or is saved, a `pietto.*` setting
changes, or another preview starts) opens nothing.

- **Pietto: Preview SQL (Single File)** runs
  `pietto emit-sql FILE --dialect DIALECT --format json` for the active saved
  `.pietto` file, where `DIALECT` is the `pietto.sqlDialect` setting:
  `postgres` (the default) or `mysql`. If the file emits several artifacts, it
  asks which one to open, in compiler order. A refusal shows Pietto's
  diagnostics and opens no SQL document. It selects no project root.
- **Pietto: Preview PostgreSQL SQL (Single File)** is the same command with
  the dialect fixed to `postgres`.
- **Pietto: Preview Project SQL (Module)** previews the public tables and
  queries of the active module of a project root in `pietto.projectRoots`. It
  runs the batch form of project emission for that one module:

  ```text
  pietto emit-sql --project=ROOT --all --module=MODULE --dialect=DIALECT --emission-contract=CONTRACT --format=json
  ```

  `MODULE` is the file's path relative to the root, with `/` separators.
  `CONTRACT` is the `pietto.emissionContract` setting, the project's
  [emission contract](https://github.com/MianliWang/pietto/blob/v0.1.10/docs/project-package.md#project-sql-emission):
  a path relative to the root, such as `contract.json`, whose target family
  is the dialect. Every file of the root must be saved. The command lists the
  batch items in project order with their status, or opens a single item
  directly. A `VERIFIED` item opens its exact SQL. A `BLOCKED` or
  `INPUT_REJECTED` item opens a plain-text report with the same lines as
  `pietto emit-sql ... --format text` writes for it: its errors, its blockers
  (code, reason, detail, location, related locations and the `hint:`
  suggestion) and its diagnostics, with control characters escaped. So does a
  whole-project `BLOCKED` document, such as a project with errors. A refusal
  of the whole batch, such as a missing contract or a module without a public
  table or query, is shown as a message.

A keybinding can pass the dialect and the contract, which take precedence over
the settings; `pietto.previewSql` takes `{"dialect": ...}` the same way. Both
settings are per resource, so each workspace folder can have its own:

```json
{
  "key": "ctrl+alt+m",
  "command": "pietto.previewProjectSql",
  "args": {"dialect": "mysql", "emissionContract": "contracts/mysql.json"}
}
```

## Pietto Models

The **Pietto Models** view in the Explorer shows, under each root of
`pietto.projectRoots`, every table and query of that `schema_version = 2`
project with its output columns. It is read-only and reads only the saved
files: it runs the public

```text
pietto explain --project=ROOT --format=json
```

through the selected interpreter and shows its
[relation columns](https://github.com/MianliWang/pietto/blob/v0.1.10/docs/spec/project-relation-columns-v1.md)
document, `pietto.project-relation-columns.v1`, which pietto 0.1.10 has.

- Tables and queries appear in project order as `table NAME` or
  `query NAME`, with their module path. Each column is `NAME: TYPE` with its
  nullability as Pietto computes it: `non_null`, `nullable` or `unknown`. An
  enum or shape column also names the module that declares it, and a
  collection column expands to its element columns.
- A project whose check fails shows how many diagnostics it has (they are in
  Problems) and no table or query. A project error is one line,
  `project error: KIND: MESSAGE`. A `schema_version = 4` project gets one line
  that says the view does not apply to it.
- A root with unsaved files is marked `shows the saved files`.
- The view runs Pietto when it becomes visible, half a second after the last
  save of a `.pietto` file or `pietto.toml` of a root, when a `pietto.*`
  setting changes, and with **Pietto: Refresh Models** (the refresh button of
  the view). It never runs while you type or while the view is hidden. A root
  runs one `explain` at a time: a new trigger stops the running one, and a
  result that a save has made stale is dropped.
- Nodes do not navigate: the column view has no source locations.

The column view is alpha: until Pietto freezes its public formats, a Pietto
release may change it. Output that the extension cannot read, such as an
unknown format, type kind or nullability, an exit code that disagrees with
`ok`, or any error output, replaces the whole root with one line that says so;
the view never shows part of such a result.

## Target diagnostics

`pietto check`, and so the language server, tells whether a file is valid
Pietto. Whether the selected database can get SQL for it is known only to
`pietto emit-sql`. Set `pietto.targetDiagnostics` to `true` (it is `false` by
default) to have the extension run `emit-sql` after each save and show what it
refuses as Warnings, with the source `pietto emit-sql (postgres)` or
`pietto emit-sql (mysql)`. This is an interim feature of the extension; the
language server itself stays without backend refusals.

- Saving a `.pietto` file, `pietto.toml` or the emission contract of a project
  root runs the batch over every public table and query of the root, with the
  `pietto.sqlDialect` and `pietto.emissionContract` settings:

  ```text
  pietto emit-sql --project=ROOT --all --dialect=DIALECT --emission-contract=CONTRACT --format=json
  ```

  A root without `pietto.emissionContract` is skipped, without a message.
- Saving a Pietto file outside every root runs
  `pietto emit-sql FILE --dialect DIALECT --format json`.
- `emit-sql` reads the saved files, so it runs half a second after the last
  save and only while no file of the root is unsaved. An edit of a file of
  the root clears its entries until the next save, and a result that a later
  save or an edit makes stale is dropped. Changing a `pietto.*` setting clears
  every entry; turning the setting on shows nothing until the next save.
- Each `PIE-B…` refusal is shown at its location, or at the start of its
  module when it has none, such as `PIE-B1004 MISSING_EVIDENCE` for a premise
  that the contract lacks. A project entry starts with its table or query, for
  example `query large_items: MISSING_EVIDENCE: identifier_case_declaration_missing`,
  and the suggestion follows on a second line.
- `emit-sql`'s own errors are shown too, such as a contract that cannot be
  read or whose target family is not the dialect: an error of the whole batch
  at the contract file, else at `pietto.toml`; an error of one table or query
  at the start of its module.
- A table, query or file with an error that is not `PIE-B…` (such as a check
  error, which the language server shows) gets no entry; a warning does not hide its
  refusals. Project loading and configuration errors are left to the language
  server as well.
- Output this extension cannot read, or a run that fails or times out, gives
  one Warning with the reason at the start of `pietto.toml` (or of the file
  outside a root) and no partial result.

## Quick fixes

The lightbulb offers two quick fixes. They are chosen by a diagnostic's public
`PIE-` code (for `PIE-S2708` also its severity), never by its message, so the
editor-only messages above, which have no code, get none.

- `PIE-S2708`, the Warning at an import or export of a file checked on its
  own, offers **Select project root**. It runs **Pietto: Select Explicit
  Project Root**, which writes the folder you choose to `pietto.projectRoots`;
  nothing is guessed. A file inside a selected root that the root's
  `[sources]` leaves out gets the same Warning: change `pietto.toml` instead,
  because choosing that root again changes nothing. A `schema_version = 1`
  project reports `PIE-S2708` as an Error that asks for `schema_version = 2`
  instead, and that gets no quick fix.
- `PIE-P1000`, a syntax error such as a retired spelling, offers **Preview
  migration (pietto migrate)**. It runs `pietto migrate FILE` on the saved
  file through the selected interpreter and opens a diff of the file and the
  migrated source, a read-only document. Nothing is written: to keep the
  result, run `pietto migrate FILE > FILE.new` yourself. A file with unsaved
  changes is not migrated; save it first. When `migrate` refuses, for example
  with `PIE-P1011` (manual migration), an error message shows its diagnostics
  and no diff opens. Every syntax error is `PIE-P1000`, so the fix is offered
  for an ordinary typing error too; there `migrate` reports the same
  `PIE-P1000` and no diff opens.

## Restricted Mode

In an untrusted workspace you get highlighting, snippets and folding. No
process is started, target diagnostics included, and `pietto.pythonPath` and `pietto.pythonArguments` from
the workspace settings are ignored. The **Pietto Models** view only asks you
to trust the workspace. Trusting the workspace starts the server.

## Windows and WSL

With **Remote WSL** the extension runs inside WSL. Select the Linux Python, for
example `/home/ada/.venvs/pietto/bin/python`, and leave
`pietto.pythonArguments` empty.

A native Windows Python works the same way: select its `python.exe`.

The Windows desktop can also run a Pietto installed in WSL:

```json
{
  "pietto.pythonPath": "C:\\Windows\\System32\\wsl.exe",
  "pietto.pythonArguments": ["-d", "Ubuntu", "--", "/home/YOUR_LINUX_USER/.venvs/pietto/bin/python"]
}
```

Create that environment inside WSL as in [Install Pietto](#install-pietto), and
replace `YOUR_LINUX_USER` and `Ubuntu` with your own. With `wsl.exe` the
extension maps drive paths both ways, `C:\work\x.pietto` to
`/mnt/c/work/x.pietto`, for document URIs and project roots. Paths that are not
on a drive letter, such as `\\wsl.localhost\...`, are not mapped: open those
projects with Remote WSL. In this mode a project root must be on a drive
letter, written relative to the workspace folder or as `C:\work\project`, and
WSL must mount the drives at its default `/mnt`. Browser-only VS Code is not
supported.

## Changes

See [CHANGELOG.md](CHANGELOG.md) for what each version changed.

## Removed in 0.2.0

Versions 0.1.0 and 0.1.1 had hover, completion, go to definition, an outline,
the **Pietto Models** and **Pietto Connections** views, a connection preview
(`pietto-connections.json` and its JSON Schema), the commands **Refresh Models
and Connections**, **Configure Connection Preview**, **Reveal Current
Declaration** and **Copy Qualified Field Path**, and the settings
`pietto.analysisDelay` and `pietto.analysisTimeout`. They ran on a Python
adapter that imported private Pietto modules. Version 0.1.0 accepted only
pietto 0.1.2, by a fingerprint of its source; 0.1.1 was tested with pietto
0.1.2 and 0.1.3 and tried any other pietto without a guarantee, so a change to
those private modules could break them. Diagnostics now come from
`pietto lsp`, a public Pietto contract. The removed features come back when
Pietto has public contracts for them. Hover, definition, the outline and
completion now come from `pietto lsp` 0.1.11 (see
[Editor features](#editor-features-pietto-0111)); they do not restore the
removed adapter or its broader navigation. The
[Pietto Models](#pietto-models) view is rebuilt on Pietto's public relation
columns, without navigation; the **Pietto Connections** view, the connection
preview and **Copy Qualified Field Path** stay removed. Project roots now live
in the `pietto.projectRoots` setting; the roots that 0.1.0 and 0.1.1 kept in
workspace state are not carried over, so run **Pietto: Select Explicit Project
Root** again.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run lint
export PIETTO_TEST_PYTHON=$HOME/.venvs/pietto/bin/python   # pietto 0.1.10 or later; 0.1.11 for every host step
export PIETTO_TEST_OLD_PYTHON=$HOME/.venvs/pietto-old/bin/python   # optional: a pietto without lsp
npm test
npm run test:host
npm run test:restricted
npm run package
npm run test:vsix
```

`npm run verify` runs the lint, `npm test` and both host suites in one go.
`npm test` runs the TextMate grammar, language configuration, snippet and
launch tests. The grammar tests compare the grammar's word lists with
`tests/fixtures/language.json` (the keywords of Pietto's `grammar/Pietto.g4`
and the built-in types, functions, aggregates and window functions of its
semantic catalogs) and tokenize `tests/fixtures/corpus.json` (every `pietto`
code block of Pietto's README and language, style and worked-example docs,
and every Pietto example, with the keyword roles, strings, numbers and
comments that Pietto's own parser found). Every snippet, expanded in the
smallest file or project that uses it, must pass `pietto check`
with no diagnostic and `pietto fmt --check`; that test runs the
`PIETTO_TEST_PYTHON` interpreter without `-I`, so
`PYTHONPATH=<pietto tree>/src` can choose a source tree. Like the host tests,
`npm test` fails when `PIETTO_TEST_PYTHON` is unset and
`.local/pietto-venv` does not exist.

When Pietto's grammar, catalogs or docs change, regenerate both fixtures from
one or more extracted Pietto trees with a Python that has
`antlr4-python3-runtime` (any pietto environment), then adjust the grammar
until `npm test` passes:

```bash
mkdir -p /tmp/pietto-main && git -C ../pietto archive main | tar -x -C /tmp/pietto-main
$PIETTO_TEST_PYTHON -I -B tests/sync_language.py /tmp/pietto-main
```

The fixtures record the git tree id of each tree they were read from.

The host tests download VS Code stable once into `.vscode-test/` (or use
`VSCODE_EXECUTABLE`), with their own user data and extensions folders, and run
the extension against the real `pietto lsp`; on Linux they need a display
(`DISPLAY`, WSLg or `xvfb-run`). Their process checks read `/proc`, so on
other systems they print a `SKIP` line instead. `npm run package` writes
`artifacts/pietto-vscode-extension-0.4.0.vsix`, and `npm run test:vsix` installs it into an
isolated profile and runs the host tests against it. The host steps of the
pietto 0.1.11 editor features run only when the server announces them: with
pietto 0.1.10 they print a `SKIP` line instead. Press F5 for an isolated
development host. See [verification](docs/verification.md) and
[architecture](docs/architecture.md).

CI (`.github/workflows/ci.yml`) runs on every push and pull request to
`main`: on Ubuntu 26.04 with Node 22 it runs `npm ci --ignore-scripts`, the
build, the lint and the Node tests of `npm test`, with `PIETTO_TEST_PYTHON`
set to a Python 3.13 virtual environment with pietto from PyPI, once with
pietto 0.1.10, the minimum, and once with pietto 0.1.11.
The host suites (`test:host`, `test:restricted`, `test:vsix`) need a display,
so CI does not run them; run them locally.

## Limits

- One server per window. `pietto.pythonPath` and `pietto.pythonArguments` are
  read at the workspace level.
- Highlighting reads one line at a time. Most Pietto keywords may also be
  names, so a clause word such as `order` or `limit` is a keyword only where
  its clause follows on the same line, and a name spelled like an operator
  (`if`, `in`, `desc`) is shown as the operator. Diagnostics are not affected.
- No query execution, rename, references, signature help, connection
  testing or database installation. Formatting and completion come from
  `pietto lsp` (pietto 0.1.11 or later; see
  [Editor features](#editor-features-pietto-0111)). No quick fix edits a
  Pietto file or applies a text edit: **Select project root** changes only
  the `pietto.projectRoots` setting, to the folder you pick.
