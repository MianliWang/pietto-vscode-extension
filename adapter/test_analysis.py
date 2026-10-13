"""Run: selected-python -I -B adapter/test_analysis.py. Uses the real compiler."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
import importlib.util
import json
import os
import shutil
import socket
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pietto_editor_analysis", ROOT / "adapter/analysis.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def source_document(text, name="single.pietto", version=1):
    path = (ROOT / "examples" / name).resolve()
    return dict(uri=path.as_uri(), path=str(path), text=text, version=version)


def run_source(text):
    reply = analysis.analyze_request(dict(id=1, documents=[source_document(text)]))
    assert not reply["issues"], reply["issues"]
    return reply


def symbol(document, name):
    return next(s for s in document["symbols"] if s["name"] == name)


def selected(text, range):
    lines = [line.rstrip("\r\n") for line in analysis.source_lines(text)]
    start, end = range["start"], range["end"]
    assert start["line"] == end["line"]
    return lines[start["line"]].encode("utf-16-le")[start["character"]*2:end["character"]*2].decode("utf-16-le")


class SingleTests(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "examples/single.pietto").read_text(encoding="utf-8")

    def test_real_fields_types_nullability_and_source(self):
        reply = run_source(self.source)
        self.assertTrue(reply["ok"])
        document = reply["documents"][0]
        self.assertEqual([(f["name"], f["type"], f["nullability"]) for f in symbol(document, "User")["fields"]],
            [("id", "Int", "non_null"), ("email", "Text", "nullable"), ("active", "Bool", "non_null"), ("order", "Int", "nullable")])
        self.assertEqual(symbol(document, "users")["provider"], "postgres.table")
        self.assertEqual(symbol(document, "users")["physical"], {"schema": "public", "table": "users"})
        self.assertEqual([f["name"] for f in symbol(document, "emails")["fields"]], ["id", "email", "normalized_email", "order"])
        self.assertEqual(symbol(document, "emails")["fields"][1]["lineage"], ["users.email"])

    def test_hover_definition_and_context_scope(self):
        document = run_source(self.source)["documents"][0]
        field = next(o for o in document["occurrences"] if o["name"] == "email" and o["range"]["start"]["line"] == 17)
        self.assertEqual(field["type"], "Text")
        self.assertEqual(field["nullability"], "nullable")
        self.assertEqual(selected(self.source, field["definition"]["range"]), "email")
        rows = [c for c in document["contexts"] if c["kind"] == "row" and c["range"]["start"]["line"] == 15]
        self.assertEqual(len(rows), 1)
        self.assertIn("users.email", [i["name"] for i in rows[0]["items"]])
        self.assertNotIn("normalized_email", [i["name"] for i in rows[0]["items"]])
        other = next(c for c in document["contexts"] if c["kind"] == "row" and c["range"]["start"]["line"] == 23)
        self.assertNotIn("normalized", [i["name"] for i in other["items"]])
        alias_source = self.source + 'query renamed:\n    from users\n    select:\n        contact = email\nquery downstream:\n    from renamed\n    select:\n        contact\n'
        document = run_source(alias_source)["documents"][0]
        reference = next(o for o in document["occurrences"] if o["name"] == "contact" and o["range"]["start"]["line"] == 32)
        self.assertEqual(selected(alias_source, reference["definition"]["range"]), "contact")
        self.assertEqual(reference["definition"]["range"]["start"]["line"], 28)

    def test_unsaved_errors_clear_and_changed_types(self):
        invalid = run_source(self.source.replace("where active", "where missing"))
        self.assertFalse(invalid["ok"])
        self.assertTrue(any(d["code"].startswith("PIE-S") for d in invalid["documents"][0]["diagnostics"]))
        self.assertTrue(all(s["state"] == "parsed" for s in invalid["documents"][0]["symbols"]))
        self.assertEqual(run_source(self.source)["documents"][0]["diagnostics"], [])
        changed = run_source(self.source.replace("id: Int", "id: Text"))
        self.assertEqual(symbol(changed["documents"][0], "emails")["fields"][0]["type"], "Text")

    def test_incomplete_recovery_is_candidates_only(self):
        incomplete = self.source.replace("        email\n", "        users.\n", 1)
        reply = run_source(incomplete)
        document = reply["documents"][0]
        self.assertFalse(reply["ok"])
        self.assertEqual(document["state"], "invalid")
        self.assertTrue(document["diagnostics"])
        self.assertTrue(all(s["state"] == "parsed" for s in document["symbols"]))
        self.assertTrue(any(i["name"] == "users.email" for c in document["contexts"] for i in c["items"]))
        self.assertFalse(any(o.get("type") for o in document["occurrences"]))
        broken = '\ufeffshape User:\n    id: Int not null\nsource users: User is postgres.table("users")\nquery broken:\n    from users\n    select:\n'
        reply = run_source(broken)
        self.assertFalse(reply["ok"])
        self.assertIn("User", [s["name"] for s in reply["documents"][0]["symbols"]])

    def test_unicode_bom_crlf_and_keyword_identifiers(self):
        text = "\ufeff" + self.source.replace("where active", 'where len("😀é") > 0 and active').replace("\n", "\r\n")
        document = run_source(text)["documents"][0]
        for occurrence in document["occurrences"]:
            if occurrence["name"] in {"User", "order", "active", "email"}:
                self.assertEqual(selected(text, occurrence["range"]), occurrence["name"])
        source = "\ufeffshape order:\r\n    by: Text not null\r\nsource order: order is postgres.table(\"orders\")\r\n"
        document = run_source(source)["documents"][0]
        shape_reference = next(o for o in document["occurrences"] if o["kind"] == "shape" and o["range"]["start"]["line"] == 2)
        self.assertEqual(shape_reference["range"]["start"]["character"], 14)
        self.assertEqual(selected(source, shape_reference["range"]), "order")
        source = 'shape Row:\n    identifier_long: Int not null\nsource rows: Row is postgres.table("public\u2028users")\nquery q:\n    from rows\n    select:\n        identifier_long\n'
        document = run_source(source)["documents"][0]
        reference = next(o for o in document["occurrences"] if o["name"] == "identifier_long" and o["range"]["start"]["line"] == 6)
        self.assertEqual(reference["range"]["end"]["character"], 23)
        self.assertEqual(selected(source, reference["range"]), "identifier_long")

    def test_strings_comments_and_escapes_excluded(self):
        text = self.source + '# query select users.email\n'
        text = text.replace("where active", r'where len("query \\\"select # hello") > 0 and active')
        document = run_source(text)["documents"][0]
        excluded = [c for c in document["contexts"] if c["kind"] == "excluded"]
        self.assertGreaterEqual(len(excluded), 3)
        self.assertTrue(all(c["items"] == [] for c in excluded))

    def test_let_prior_visibility_and_window_group_scope(self):
        text = self.source.replace("normalized = lower(email)", "first = email\n        normalized = lower(first)")
        document = run_source(text)["documents"][0]
        lets = [c for c in document["contexts"] if c["kind"] == "let"]
        self.assertNotIn("normalized", [i["name"] for i in lets[0]["items"]])
        self.assertNotIn("first", [i["name"] for i in lets[0]["items"]])
        self.assertIn("first", [i["name"] for i in lets[1]["items"]])
        stages = run_source((ROOT / "examples/stages.pietto").read_text())["documents"][0]
        grouped = next(c for c in stages["contexts"] if c["kind"] == "window" and c["range"]["start"]["line"] < 20)
        names = [i["name"] for i in grouped["items"]]
        self.assertIn("total", names)
        self.assertNotIn("amount", names)
        self.assertNotIn("metrics.amount", names)
        self.assertNotIn("ranked", names)
        reference = next(o for o in stages["occurrences"] if o["name"] == "total" and o["range"]["start"]["line"] == 18)
        self.assertEqual(reference["type"], "Int")
        self.assertEqual(reference["nullability"], "nullable")
        self.assertEqual(reference["range"], {"start": {"line": 18, "character": 16}, "end": {"line": 18, "character": 21}})
        self.assertEqual(reference["definition"]["range"], {"start": {"line": 15, "character": 8}, "end": {"line": 15, "character": 13}})
        ordered = (ROOT / "examples/stages.pietto").read_text()
        ordered = ordered.replace("                total\n", "                total\n    order by:\n        total\n", 1)
        document = run_source(ordered)["documents"][0]
        order = next(c for c in document["contexts"] if c["kind"] == "order" and c["range"]["start"]["line"] < 22)
        self.assertIn("total", [i["name"] for i in order["items"]])
        self.assertNotIn("amount", [i["name"] for i in order["items"]])
        occurrence = next(o for o in document["occurrences"] if o["name"] == "total" and o["range"]["start"]["line"] == 20)
        self.assertEqual(occurrence["type"], "Int")
        self.assertEqual(selected(ordered, occurrence["definition"]["range"]), "total")

    def test_ambiguous_decl_does_not_choose_first(self):
        source = "shape X:\n    id: Int not null\nshape X:\n    value: Text nullable\nsource rows: X is postgres.table(\"rows\")\n"
        reply = run_source(source)
        self.assertFalse(reply["ok"])
        references = [o for o in reply["documents"][0]["occurrences"] if o["name"] == "X" and o["range"]["start"]["line"] == 4]
        self.assertTrue(all("definition" not in o for o in references))
        self.assertEqual(len([s for s in reply["documents"][0]["symbols"] if s["name"] == "X"]), 2)

    def test_partial_same_name_declarations_keep_distinct_authored_ids(self):
        source = "shape X:\n    id: Int not null\nshape X:\n    value: Text nullable\nquery broken:\n    from missing\n    select:\n"
        reply = run_source(source)
        document = reply["documents"][0]
        declarations = [s for s in document["symbols"] if s["kind"] == "shape" and s["name"] == "X"]
        self.assertFalse(reply["ok"])
        self.assertEqual(document["state"], "invalid")
        self.assertEqual(len(declarations), 2)
        self.assertEqual(len({s["id"] for s in declarations}), 2)
        self.assertEqual([s["selectionRange"]["start"]["line"] for s in declarations], [0, 2])
        self.assertTrue(all(s["state"] == "parsed" for s in declarations))

    def test_snippet_constructs_are_real_syntax(self):
        source = "shape Record:\n    id: Int not null\n    name: Text nullable\nsource records: Record is postgres.table(\"public.records\")\nquery result:\n    from records\n    select:\n        id\ntable kept:\n    from records\n    select:\n        id\ntype Identifier = Int not null\n"
        self.assertTrue(run_source(source)["ok"])

    def test_no_network_driver_or_credential_discovery(self):
        with mock.patch.object(socket, "socket", side_effect=AssertionError("Network forbidden")):
            self.assertTrue(run_source(self.source)["ok"])
        self.assertFalse(any(name.split(".")[0] in {"psycopg", "pyarrow", "mysql", "adbc_driver_manager"} for name in sys.modules))
        response = run_source(self.source.replace('"public.users"', '"postgres://secret:password@server/db"'))
        serialized = json.dumps(response)
        self.assertNotIn("secret:password", serialized)
        self.assertNotIn("physical", symbol(response["documents"][0], "users"))

    def test_input_budgets_and_incompatible_identity(self):
        reply = analysis.analyze_request(dict(id=1, documents=[source_document("x" * (analysis.MAX_BYTES + 1))]))
        self.assertFalse(reply["ok"])
        self.assertIn("byte limit", reply["issues"][0])
        with mock.patch.object(analysis, "API_FINGERPRINT", "wrong"):
            analysis.compiler_identity.cache_clear()
            reply = analysis.analyze_request(dict(id=1, documents=[source_document(self.source)]))
        analysis.compiler_identity.cache_clear()
        self.assertIn("Incompatible", reply["issues"][0])


@unittest.skipIf(os.name == "nt", "Current core trusted project loader requires WSL on this Windows host.")
class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="pietto-adapter-test-")
        self.root = Path(self.temporary.name) / "项目"
        shutil.copytree(ROOT / "examples/project", self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, documents=()):
        return analysis.analyze_request(dict(id=2, root=str(self.root), documents=list(documents)))

    def test_import_reexport_same_name_and_correct_field_owner(self):
        reply = self.request()
        self.assertEqual(reply["issues"], [])
        self.assertTrue(reply["ok"], [(d["uri"], d["diagnostics"]) for d in reply["documents"]])
        emails = next(d for d in reply["documents"] if d["uri"].endswith("emails.pietto"))
        self.assertEqual(symbol(emails, "User")["fields"][0]["name"], "local_only")
        self.assertEqual(symbol(emails, "User")["fields"][0]["type"], "Text")
        field = next(o for o in emails["occurrences"] if o["name"] == "email" and o.get("definition"))
        self.assertTrue(field["definition"]["uri"].endswith("users.pietto"))
        people = next(o for o in emails["occurrences"] if o["name"] == "people" and o["kind"] == "source")
        self.assertTrue(people["definition"]["uri"].endswith("users.pietto"))
        self.assertFalse(any("pietto-editor-" in json.dumps(d) for d in reply["documents"]))
        self.assertEqual(symbol(emails, "emails")["fields"][1]["lineage"], ["models/users.pietto::users.email"])
        path = self.root / "models/emails.pietto"
        text = path.read_text() + 'query contacts:\n    from people\n    select:\n        contact = email\nquery downstream:\n    from contacts\n    select:\n        contact\n'
        reply = self.request([dict(uri=path.as_uri(), path=str(path), text=text, version=3)])
        self.assertTrue(reply["ok"])
        document = next(d for d in reply["documents"] if d["uri"] == path.as_uri())
        references = [o for o in document["occurrences"] if o["name"] == "contact" and o.get("definition")]
        reference = max(references, key=lambda o:o["range"]["start"]["line"])
        self.assertEqual(selected(text, reference["definition"]["range"]), "contact")
        self.assertEqual(reference["definition"]["uri"], path.as_uri())

    def test_unsaved_imported_file_edits_propagate_and_never_save(self):
        path = self.root / "models/users.pietto"
        original = path.read_bytes()
        text = original.decode().replace("email: Text", "email: Int")
        reply = self.request([dict(uri=path.as_uri(), path=str(path), text=text, version=8)])
        self.assertTrue(reply["ok"], reply["issues"])
        emails = next(d for d in reply["documents"] if d["uri"].endswith("emails.pietto"))
        self.assertEqual(symbol(emails, "emails")["fields"][1]["type"], "Int")
        self.assertEqual(path.read_bytes(), original)
        users = next(d for d in reply["documents"] if d["uri"].endswith("users.pietto"))
        self.assertEqual(users["version"], 8)

    def test_bad_import_blocks_verified_model_and_fixes_clear(self):
        path = self.root / "models/emails.pietto"
        text = path.read_text().replace("models/facade.pietto", "missing.pietto")
        reply = self.request([dict(uri=path.as_uri(), path=str(path), text=text, version=2)])
        self.assertFalse(reply["ok"])
        self.assertTrue(any(d["code"] == "PIE-S2701" for doc in reply["documents"] for d in doc["diagnostics"]))
        self.assertFalse(any(s["state"] == "checked" for doc in reply["documents"] for s in doc["symbols"]))
        self.assertTrue(self.request()["ok"])

    def test_join_visibility_null_extension_let_and_window(self):
        reply = self.request()
        self.assertEqual(reply["issues"], [])
        joined = next(d for d in reply["documents"] if d["uri"].endswith("joined.pietto"))
        fields = symbol(joined, "joined")["fields"]
        self.assertEqual([(f["name"], f["nullability"]) for f in fields],
                         [("account_id", "non_null"), ("event_id", "nullable"), ("bound_key", "nullable"), ("ranked", "non_null")])
        row = next(c for c in joined["contexts"] if c["kind"] == "row" and c["range"]["start"]["line"] == 23)
        names = [i["name"] for i in row["items"]]
        self.assertIn("event.id", names)
        self.assertNotIn("id", names)  # Ambiguous account/event field is not an arbitrary winner.
        self.assertNotIn("event_id", names)
        self.assertNotIn("ranked", names)
        qualify = next(c for c in joined["contexts"] if c["kind"] == "qualify")
        self.assertIn("ranked", [i["name"] for i in qualify["items"]])
        match = next(c for c in joined["contexts"] if c["kind"] == "join_on")
        self.assertIn("event.account_id", [i["name"] for i in match["items"]])
        self.assertNotIn("key", [i["name"] for i in match["items"]])
        reference = next(o for o in joined["occurrences"] if o["name"] == "event.account_id" and o["range"]["start"]["line"] == 20)
        self.assertEqual(reference["nullability"], "non_null")

    def test_hidden_join_intermediate_is_not_a_candidate(self):
        source = '''shape AccountRow:
    id: Int not null
    unique key on id
shape EventRow:
    id: Int not null
    account_id: Int not null
    hidden_metric: Int nullable
    unique key on id
shape DetailRow:
    id: Int not null
    event_id: Int not null
    unique key on id
source accounts: AccountRow is postgres.table("accounts")
source events: EventRow is postgres.table("events")
source details: DetailRow is postgres.table("details")
relationship account_events:
    endpoint account: accounts
    endpoint event: events
    on account.id == event.account_id
relationship event_details:
    endpoint event: events
    endpoint detail: details
    on event.id == detail.event_id
query result:
    from accounts
    inner join details as detail:
        from accounts
        via account_events: account -> event
        via event_details: event -> detail
    select:
        account_id = accounts.id
        detail_id = detail.id
'''
        (self.root / "models/hidden.pietto").write_text(source)
        reply = self.request()
        self.assertTrue(reply["ok"], [(d["uri"], d["diagnostics"]) for d in reply["documents"]])
        document = next(d for d in reply["documents"] if d["uri"].endswith("hidden.pietto"))
        context = next(c for c in document["contexts"] if c["kind"] == "row" and c["range"]["start"]["line"] == 29)
        names = [i["name"] for i in context["items"]]
        self.assertIn("detail.id", names)
        self.assertNotIn("hidden_metric", names)
        self.assertNotIn("event.hidden_metric", names)
        relationship = symbol(document, "account_events")
        self.assertEqual(relationship["state"], "checked")
        self.assertEqual([e["relation"] for e in relationship["relationship"]["endpoints"]], ["accounts", "events"])
        self.assertTrue(all(e.get("definition") for e in relationship["relationship"]["endpoints"]))

    def test_grouped_order_project_uses_selected_stage(self):
        source = (ROOT / "examples/stages.pietto").read_text().replace("                total\n", "                total\n    order by:\n        total\n", 1)
        (self.root / "models/stages.pietto").write_text(source)
        reply = self.request()
        self.assertTrue(reply["ok"], [(d["uri"], d["diagnostics"]) for d in reply["documents"]])
        document = next(d for d in reply["documents"] if d["uri"].endswith("stages.pietto"))
        order = next(c for c in document["contexts"] if c["kind"] == "order" and c["range"]["start"]["line"] < 22)
        self.assertIn("total", [i["name"] for i in order["items"]])
        self.assertNotIn("amount", [i["name"] for i in order["items"]])
        reference = next(o for o in document["occurrences"] if o["name"] == "total" and o["range"]["start"]["line"] == 20)
        self.assertEqual(reference["type"], "Int")
        self.assertEqual(selected(source, reference["definition"]["range"]), "total")
        window_reference = next(o for o in document["occurrences"] if o["name"] == "total" and o["range"]["start"]["line"] == 18)
        self.assertEqual(window_reference["type"], "Int")
        self.assertEqual(window_reference["nullability"], "nullable")
        self.assertEqual(window_reference["definition"]["range"], {"start": {"line": 15, "character": 8}, "end": {"line": 15, "character": 13}})

    def test_joined_group_window_alias_occurrence(self):
        source = (ROOT / "examples/project/models/joined.pietto").read_text().split("query joined:", 1)[0] + '''relationship account_events:
    endpoint account: accounts
    endpoint event: events
    on account.id == event.account_id

query grouped_window:
    from accounts
    inner join events as event:
        from accounts
        via account_events: account -> event
    group by:
        event.account_id
    select:
        account_id = event.account_id
        total = sum(event.metric)
        ranked = row_number() window:
            order by:
                total
'''
        path = self.root / "models/window_joined.pietto"
        path.write_text(source)
        reply = self.request()
        self.assertTrue(reply["ok"], [(d["uri"], d["diagnostics"]) for d in reply["documents"]])
        document = next(d for d in reply["documents"] if d["uri"].endswith("window_joined.pietto"))
        reference = next(o for o in document["occurrences"] if o["name"] == "total" and o["range"]["start"]["line"] == 33)
        self.assertEqual(reference["type"], "Int")
        self.assertEqual(reference["nullability"], "nullable")
        self.assertEqual(reference["definition"]["uri"], path.as_uri())
        self.assertEqual(reference["definition"]["range"], {"start": {"line": 30, "character": 8}, "end": {"line": 30, "character": 13}})
        window = next(c for c in document["contexts"] if c["kind"] == "window")
        self.assertIn("total", [i["name"] for i in window["items"]])
        self.assertNotIn("event.metric", [i["name"] for i in window["items"]])

    def test_membership_excludes_open_files_and_escape_rejected(self):
        path = self.root / "unselected.pietto"
        path.write_text("shape Other:\n    id: Int not null\n")
        reply = self.request([dict(uri=path.as_uri(), path=str(path), text=path.read_text(), version=1)])
        self.assertTrue(reply["ok"], reply["issues"])
        self.assertFalse(any(d["uri"] == path.as_uri() for d in reply["documents"]))
        outside = self.root.parent / "outside.pietto"
        reply = self.request([dict(uri=outside.as_uri(), path=str(outside), text="", version=1)])
        self.assertIn("escapes", reply["issues"][0])

    def test_malformed_config_and_no_parent_inheritance(self):
        (self.root / "pietto.toml").write_text("schema_version = 2\n[sources]\ninclude = [\"../*.pietto\"]\n")
        self.assertFalse(self.request()["ok"])
        reply = analysis.analyze_request(dict(id=1, root=str(self.root / "models"), documents=[]))
        self.assertFalse(reply["ok"])
        self.assertTrue(reply["issues"])

    def test_windows_path_mapping_returns_original_uris(self):
        root = str(ROOT / "examples/project")
        if not root.startswith("/mnt/"):
            self.skipTest("Drive mapping witness requires the WSL fixture mount.")
        windows = root[5].upper() + ":" + root[6:].replace("/", "\\")
        reply = analysis.analyze_request(dict(id=1, root=windows, documents=[]))
        self.assertTrue(reply["ok"], reply["issues"])
        self.assertTrue(all(d["uri"].startswith("file:///D:/") for d in reply["documents"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
