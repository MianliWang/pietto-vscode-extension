# Pietto for VS Code

Compiler-backed editing for `.pietto`, with native **Pietto Models** and
**Pietto Connections** views. This extension previews declarations and explicit
configuration. It never runs queries, connects to databases, probes hosts, or
fetches catalogs. Connectivity and physical schema existence are always **not checked**.

## Install and select Python

Install **Pietto** from the Visual Studio Marketplace when available, or install
the packaged VSIX through **Extensions: Install from VSIX…**. The local
verification workflow builds and tests a package; it does not publish it.

Analysis requires an explicitly selected compatible Python environment. Opening
a file never installs dependencies. Create an isolated environment and install
the exact compatible compiler and parser runtime:

```powershell
py -3.12 -m venv .venv-pietto
.venv-pietto/Scripts/python.exe -m pip install pietto==0.1.2 antlr4-python3-runtime==4.13.2
```

Run **Pietto: Select Python Interpreter**, and select that executable. Selection
is stored in the workspace settings. Outside a workspace it applies only to the
current session. The extension does not change your normal VS Code profile.
Missing or incompatible Python leaves highlighting, snippets, and basic editing
available, with an actionable analysis state in the model view.

Compatibility is bound to the actual package source fingerprint, not merely
`pietto.__version__` or package metadata. See [architecture and verification](docs/architecture.md)
for the exact tested origins and references. Interpreter launch uses `-I -B`, an
extension-owned helper, and shell-free arguments. Workspace-shadowed Python
modules are not used. Analysis runs only in a trusted workspace.

### Windows projects and Remote WSL

The selected core's trusted project-file loader fails on native Windows. Native
Windows Python supports single-file analysis; explicit project checking requires
Linux Python. Keep the compiler's trust checks intact and use Remote WSL, or
configure the desktop extension to launch an isolated WSL interpreter:

```json
{
  "pietto.pythonPath": "C:\\Windows\\System32\\wsl.exe",
  "pietto.pythonArguments": [
    "-d", "Ubuntu", "--",
    "/home/YOUR_LINUX_USER/.venvs/pietto/bin/python"
  ]
}
```

Create that environment inside WSL with `python3 -m venv ~/.venvs/pietto`, then run
`~/.venvs/pietto/bin/python -m pip install pietto==0.1.2 antlr4-python3-runtime==4.13.2`.
Replace `YOUR_LINUX_USER` and the distribution name with your own. Windows document URIs map back to their original
editor identities. In a Remote WSL extension host, select the Linux Python path
directly and leave launcher arguments empty. Browser-only VS Code is unsupported.

## Editing

Open [single.pietto](examples/single.pietto) for a working example. Highlighting
respects lowercase keywords, contextual keyword identifiers, escaped strings,
`#` comments, and colon/indent blocks. Use VS Code's normal completion, Hover,
Go to Definition, Outline, Problems, folding, and comment commands.

Completion includes compiler-visible declarations, real types and fields, and
qualified field candidates. Hover reports known types and nullability, compiler
definitions, and supported builtin signatures. Ambiguous or unavailable facts
do not acquire a navigation target. LET, GROUP, JOIN, and window candidates come
from the compiler's stage owners; another query's fields do not become visible
by matching their spelling.

For imports/re-exports, use **Pietto: Select Explicit Project Root**, choosing an
open workspace folder or a subfolder inside it. Open [examples/project](examples/project)
with its `schema_version = 2` `pietto.toml`. Imports in this compiler use exact
**project-root-relative** logical paths, such as `models/users.pietto`.
No arbitrary parent configuration is inherited. Core source selection owns
project membership. Excluded open files receive independent single-file analysis.
Use **Pietto: Use Single File Mode** to clear explicit project selection.

Unsaved local/imported buffers update analysis without saving or rewriting
source files. Invalid edits clear current checked observations immediately;
useful parsed declarations can remain labelled **parsed**. A bounded completion
repair is only editor assistance: the original errors remain in Problems and
the repaired source is never reported as a checked program.

## Models

Expand workspace/project, module, declaration, and input/output schema nodes.
Fields show ordered types and nullability. Proven compiler field origins have
navigation children; safe declared physical mappings are labelled **not checked**.
Parsed declarations and checked models have distinct labels.

Click declarations/fields to navigate. Use the view's refresh and reveal buttons.
**Copy Qualified Field Path** copies the editor-qualified identity
`<document URI>::<declaration>.<field>` when no compiler path is supplied. This
identifies the module and workspace; it is not a new Pietto expression syntax.
Tree identities survive harmless refreshes. Navigation resolves the current
observation rather than using a cached item's old range.

## Static connection preview

Use **Pietto: Configure Connection Preview** to open/create
`pietto-connections.json` at a selected workspace root. This is an
**extension-owned format**, separate from core `pietto.toml` and execution authority.
VS Code provides its JSON Schema. Copy the [valid example](examples/pietto-connections.json).

```json
{
  "version": 1,
  "profiles": [{
    "id": "preview", "displayName": "Warehouse preview", "provider": "postgres",
    "host": "localhost", "port": 5432, "database": "analytics"
  }],
  "bindings": [{
    "module": "single.pietto", "source": "users", "profile": "preview",
    "tables": [{"declaration": "users", "schema": "public", "table": "users"}]
  }]
}
```

Profiles use only the documented non-secret allowlist. Bindings require exact
workspace-relative module paths and source names; no basename/dialect inference
occurs. Trees distinguish **declared**, **configured**, **unbound**, and **invalid
configuration**. Explicit physical mappings remain **not checked**; matching a
table's name alone does not establish its source ownership.

Passwords, tokens, credential URIs, private keys, unknown fields, executable
configuration, and environment interpolation are rejected. Configuration errors
never echo raw keys/values. File reads and creation reject escaping/dangling links.
Do not store secrets in this file. No driver or PyArrow dependency is needed for
editing and these previews. No telemetry or source upload is implemented.

## Develop and verify locally

```powershell
npm ci --ignore-scripts
npm run verify
npm run package
```

`verify` runs lint, TypeScript/build, real TextMate/config/protocol tests, real
compiler adapter tests, desktop Extension Host provider/tree tests, and a
separate trust-enabled Restricted Mode host. The fixtures and profiles live in
ignored task directories. Test runners accept `VSCODE_EXECUTABLE`,
`PIETTO_TEST_PYTHON`, and launcher/project interpreter environment overrides.
Tests never use the user's normal profile. Press F5 for an isolated development
host; select Python there before analysis.

Local VSIX and measured results are in ignored `artifacts/`. See
[verification evidence](docs/verification.md) for executed results, historical
failures repaired during integration, timing workload, and checks that were not run.

## Limits

- Explicit module project models require `schema_version = 2`. Legacy flat
  projects preserve project diagnostics and parsed declarations, without a
  checked project model/field index.
- Windows desktop project analysis uses the WSL bridge; native Windows project
  analysis is unavailable in the tested core. Automated desktop host tests passed;
  GUI pixel inspection and a Remote WSL GUI/session remain **NOTRUN**. Browser-only
  VS Code is unsupported.
- Invalid programs provide conservative syntax assistance; complete recovery
  and authoritative semantic navigation through every incomplete construct are
  not promised. Unknown/ambiguous fields have no invented definitions.
- 128 open/selected files, 1 MiB per source/configuration file, 16 MiB per project,
  one compiler request at a time, one coalesced refresh, and 20 timing records.
- No query execution, formatter, rename/references engine, connection testing,
  live introspection, results grids, charts, notebooks, or database installation.
