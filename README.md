# Pietto for VS Code

Highlighting, snippets and folding for `.pietto` files, and Problems
diagnostics from the Pietto language server, `pietto lsp`. The extension starts
`pietto lsp` from a Python environment that you choose. It never installs
anything, runs queries, or connects to a database.

## Install Pietto

`pietto lsp` first ships in **pietto 0.1.10**, which is not published yet. Use
pietto 0.1.10 or later, in its own virtual environment:

```bash
python3 -m venv ~/.venvs/pietto
~/.venvs/pietto/bin/python -m pip install "pietto>=0.1.10"
```

On Windows:

```powershell
py -3.12 -m venv $HOME\.venvs\pietto
~\.venvs\pietto\Scripts\python.exe -m pip install "pietto>=0.1.10"
```

Until 0.1.10 is on PyPI, test with a wheel built from a Pietto checkout that
has `pietto lsp`:

```bash
cd pietto
uv build --wheel --out-dir /tmp/pietto-wheel
~/.venvs/pietto/bin/python -m pip install /tmp/pietto-wheel/pietto-*-py3-none-any.whl
~/.venvs/pietto/bin/pietto lsp --help    # prints "usage: pietto lsp"
```

## Install the extension

The extension is not on the Marketplace. Build the VSIX (see
[Develop and verify](#develop-and-verify)) and install
`artifacts/pietto-vscode-extension-0.2.0.vsix` with **Extensions: Install from
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
which Pietto runs. Changing `pietto.pythonPath` or `pietto.pythonArguments`
restarts the server.

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
or closed. After you edit `pietto.toml`, or change modules outside the editor
(for example with `git checkout`), run **Pietto: Restart Language Server**.

Open [examples/project](examples/project), select it as the root, and open
`models/emails.pietto`: it imports from `models/facade.pietto`, which re-exports
`models/users.pietto`, and the Problems panel stays empty. Import paths are
relative to the project root, such as `"models/users.pietto"`.

## Diagnostics

The Problems panel shows what `pietto check` reports, as the server contract
([Pietto docs/editor-lsp.md](https://github.com/MianliWang/pietto/blob/main/docs/editor-lsp.md))
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
- Backend refusals (`PIE-B…`) appear only in `pietto emit-sql`; the editor runs
  no SQL dialect.

The server adds these editor-only messages, without a `PIE-` code, at the start
of the file:

| When | Message |
|---|---|
| Two project roots select the same file | `This file belongs to two project roots: <root 1> and <root 2>. Keep one of them in projectRoots.` |
| A selected file is open under two URIs | `This file is open under two URIs: <uri 1> and <uri 2>. Keep one of them open.` |
| Two selected files differ only in letter case | `This file is selected under two names that differ only in letter case: <name 1> and <name 2>. Rename one of them.` |
| The editor sent a partial change | `Pietto needs whole-document changes; reopen this file.` |

Only diagnostics are provided: no hover, completion, go to definition, outline,
formatting or SQL. Run one Pietto diagnostics source per file; if another tool
already runs `pietto check` on save, turn it off.

## Restricted Mode

In an untrusted workspace you get highlighting, snippets and folding. No
process is started, and `pietto.pythonPath` and `pietto.pythonArguments` from
the workspace settings are ignored. Trusting the workspace starts the server.

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

## Removed in 0.2.0

Version 0.1.0 had hover, completion, go to definition, an outline, the **Pietto
Models** and **Pietto Connections** views, a connection preview
(`pietto-connections.json` and its JSON Schema), the commands **Refresh Models
and Connections**, **Configure Connection Preview**, **Reveal Current
Declaration** and **Copy Qualified Field Path**, and the settings
`pietto.analysisDelay` and `pietto.analysisTimeout`. They ran on a Python
adapter that imported private Pietto modules and accepted only pietto 0.1.2,
by a fingerprint of its source, so any later Pietto broke them. Diagnostics now
come from `pietto lsp`, a public Pietto contract. The removed features come back
when Pietto has public contracts for them. Project roots now live in the
`pietto.projectRoots` setting; the roots that 0.1.0 kept in workspace state are
not carried over, so run **Pietto: Select Explicit Project Root** again.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run lint
export PIETTO_TEST_PYTHON=$HOME/.venvs/pietto/bin/python   # pietto 0.1.10 or later
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
smallest file or two-module project that uses it, must pass `pietto check`
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
`artifacts/pietto-vscode-extension-0.2.0.vsix`, and `npm run test:vsix` installs it into an
isolated profile and runs the host tests against it. Press F5 for an isolated
development host. See [verification](docs/verification.md) and
[architecture](docs/architecture.md).

## Limits

- One server per window. `pietto.pythonPath` and `pietto.pythonArguments` are
  read at the workspace level.
- Highlighting reads one line at a time. Most Pietto keywords may also be
  names, so a clause word such as `order` or `limit` is a keyword only where
  its clause follows on the same line, and a name spelled like an operator
  (`if`, `in`, `desc`) is shown as the operator. Diagnostics are not affected.
- No query execution, formatter, rename, references, connection testing or
  database installation.
