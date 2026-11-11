# Changelog

## 0.4.0 (candidate)

- A compatible Pietto language server supplies standard hover, go to
  definition and document symbols from its current diagnostic snapshot.
  Definition covers only exact retained `type` and `from` targets; hover shows
  retained declaration/type facts and symbols list named top-level
  declarations. Unknown, ambiguous or stale facts produce no navigation
  result. This does not restore the removed private Python adapter, completion
  or the model and connection views.
- **Pietto: Preview SQL (Single File)** previews MySQL as well as PostgreSQL,
  by the new `pietto.sqlDialect` setting or a `{"dialect": ...}` command
  argument.
- **Pietto: Preview Project SQL (Module)** runs the public batch
  `pietto emit-sql --project ROOT --all --module MODULE` for the active module
  of a project root, with the dialect and the new `pietto.emissionContract`
  setting (or command arguments). It refuses while any file of the root is
  unsaved, offers the module's tables and queries in project order, opens the
  exact SQL of a `VERIFIED` item, and opens a `BLOCKED` or `INPUT_REJECTED`
  document as a plain-text report with the same lines as Pietto's own
  `--format text` failure output: CLI errors, blockers with their locations,
  related locations and hints, then diagnostics, with control characters
  escaped. A result whose batch status disagrees with its items or failure
  document is refused. Both previews ignore JSON fields they do not read and
  refuse an unknown document format. Both need pietto 0.1.10, like the
  language server.
- Quick fixes keyed on public diagnostic codes, never on message text:
  `PIE-S2708` (the single-file Warning at an import or export) offers
  **Select project root**, which writes the chosen folder to
  `pietto.projectRoots`; `PIE-P1000` offers **Preview migration (pietto
  migrate)**, a diff of the saved file and the output of `pietto migrate FILE`
  in a read-only document. Nothing is written; an unsaved file or a refusal
  such as `PIE-P1011` opens no diff.
- The language server restarts when a `pietto.toml` inside a selected project
  root is created, changed or deleted, and on a change of any `pietto.*`
  setting, half a second after the last such change. Modules changed outside
  the editor still need **Pietto: Restart Language Server**.
- A preview whose interpreter cannot be started at all, such as an empty
  `pietto.pythonPath`, shows an error message with the cause.

## 0.3.0 (candidate)

- **Pietto: Preview PostgreSQL SQL (Single File)** opens one PostgreSQL SQL
  artifact for a saved, unchanged `.pietto` file. It invokes the public
  `pietto emit-sql` command through the selected interpreter and never executes
  SQL or writes the source file.

## 0.2.1 (2026-11-07)

- An extension and Marketplace icon again, now the Pietto icon of the Pietto
  brand kit, and a file icon from the kit for `.pietto` files that VS Code
  shows where the file icon theme has only a generic icon for them.
- Marketplace details: keywords, a homepage, an issue tracker and a banner
  color.
- Snippets for the pietto 0.1.10 language: `constant` (a top-level constant),
  `query` with a typed parameter, `asof` (an asof JOIN), `collect` (a query
  that collects a relation let), `unnest`, `median`, `quantile`, `variance`,
  `count_distinct` of two fields, and `any` and `all` over the rows of a group.
  The query parameter, `collect` and `unnest` work in explicit-module projects
  (`schema_version = 2`). Each snippet, expanded, passes `pietto check` and
  `pietto fmt --check`.
- `unnest(` is highlighted as a built-in call.

## 0.2.0 (2026-11-07)

- Diagnostics come from the Pietto language server, `pietto lsp`, which needs
  pietto 0.1.10 or later in the Python that `pietto.pythonPath` names. The
  server starts only in a trusted workspace; a missing or older pietto gets
  one error message instead of a restart loop.
- Explicit project roots live in the `pietto.projectRoots` setting, written by
  **Pietto: Select Explicit Project Root** and cleared by **Pietto: Use Single
  File Mode**. With `wsl.exe` as the launcher on the Windows desktop, drive
  paths map to `/mnt`.
- The grammar is rebuilt from Pietto's grammar and built-in catalogs, and the
  snippets follow Pietto's canonical style.
- Removed, until Pietto has public contracts for them: hover, completion, go
  to definition, the outline, the **Pietto Models** and **Pietto
  Connections** views, the connection preview, their commands and the
  `pietto.analysisDelay` and `pietto.analysisTimeout` settings. They ran on a
  Python adapter that imported private Pietto modules: 0.1.0 accepted only
  pietto 0.1.2, and 0.1.1 was tested with pietto 0.1.2 and 0.1.3 and tried
  any other pietto without a guarantee. See
  [Removed in 0.2.0](README.md#removed-in-020).
- No extension icon: the 0.1.1 icon was left out.

## 0.1.1 (2026-10-16)

- The Pietto brand mark as the extension and Marketplace icon.
- Support for pietto 0.1.3 next to 0.1.2. Any other pietto, newer or locally
  modified, is no longer refused: the adapter tries it and marks it as
  unverified.
- With pietto 0.1.3 in an explicit-module project, editing assistance, the
  outline and the **Pietto Models** view follow relation lets, query
  parameters, typed VALUES, relation reads, captures, computed groups and
  table-function inputs.
- More contextual highlighting and project snippets.

## 0.1.0 (2026-10-13)

- First version: highlighting, snippets and folding for `.pietto` files, and,
  through a Python adapter for pietto 0.1.2, diagnostics, hover, completion,
  go to definition, an outline, the **Pietto Models** and **Pietto
  Connections** views and a connection preview.
