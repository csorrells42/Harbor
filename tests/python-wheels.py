import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import sys
import tempfile
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / "scripts/portable" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pin = load("pin_wheels", "pin-python-wheels.py")
stager = load("stage_wheels", "stage-python-groups.py")
capture = load("source_capture", "capture-source-python-inputs.py")
source_build = load("source_build", "build-python-source-deps.py")
project_build = load("project_build", "build-python-projects.py")


class WheelContracts(unittest.TestCase):
    def test_explicit_group_selection_cannot_add_unknown_or_duplicate_groups(self):
        self.assertEqual(pin.selected_groups({"pythonGroups": ["python-build"]}), ["python-build"])
        for groups in ([], ["python-build", "python-build"], ["../escape"], [None], "python-build"):
            with self.subTest(groups=groups), self.assertRaises(ValueError):
                pin.selected_groups({"pythonGroups": groups})

    def test_declared_subset_is_bound_to_manifest_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            pins, manifest, cache, contract = self.fixture(Path(temporary))
            data = json.loads(manifest.read_bytes())
            data["pythonGroups"] = ["python-tools"]
            manifest.write_text(json.dumps(data), encoding="utf-8")
            contract["packageInputsSha256"] = stager.sha_file(manifest)
            contract["groups"] = [group for group in contract["groups"] if group["id"] == "python-tools"]
            (pins / "groups.json").write_text(json.dumps(contract), encoding="utf-8")
            self.assertEqual(len(stager.validate_plan(pins, manifest, cache)[0]), 1)
            data["pythonGroups"] = ["python-tools", "fastmcp-tools"]
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "manifest hash"):
                stager.validate_plan(pins, manifest, cache)

    def test_source_metadata_is_static_and_extra_dependencies_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / "pyproject.toml"
            text = '[build-system]\nbuild-backend="hatchling.build"\nrequires=["hatchling"]\n[project]\nname="fixture"\nversion="1.0"\ndependencies=["base>=1"]\n[project.optional-dependencies]\nimages=["pillow>=10"]\n'
            file.write_text(text, encoding="utf-8")
            requirements, record = capture.project_requirements(root, ["images"])
            self.assertEqual(requirements, ["base>=1", "pillow>=10"])
            self.assertEqual(record["version"], "1.0")
            for changed in (text.replace('version="1.0"', 'version="1.0"\ndynamic=["dependencies"]'), text.replace('"base>=1"', '"base @ https://example.com/source.tar.gz"'), text.replace('hatchling.build', 'custom.execute')):
                file.write_text(changed, encoding="utf-8")
                with self.assertRaises(ValueError):
                    capture.project_requirements(root, ["images"])

    def test_dynamic_version_is_parsed_without_executing_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "version.py").write_text('raise RuntimeError("must never execute")\n__version__ = "1.2.3"\n', encoding="utf-8")
            metadata = {"project": {"dynamic": ["version"]}, "tool": {"hatch": {"version": {"path": "version.py"}}}}
            self.assertEqual(capture.project_version(root, metadata)[0], "1.2.3")
            (root / "version.py").write_text('__version__ = str(123)\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                capture.project_version(root, metadata)

    def test_unreviewed_source_archive_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "unsafe.tar.gz"
            archive.write_bytes(b"unreviewed source archive")
            with self.assertRaisesRegex(ValueError, "Unreviewed source archive"):
                source_build.extract_reviewed(archive, root / "output")
            self.assertFalse((root / "output").exists())

    def test_source_wheel_binding_and_complete_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pins, manifest, cache, contract = self.fixture(root)
            source = root / "source-wheels"
            (source / "wheels").mkdir(parents=True)
            wheel = source / "wheels/proxy_tools-0.1.0-py3-none-any.whl"
            wheel.write_bytes(b"reviewed wheel fixture, never executed")
            record = {"name": "proxy-tools", "version": "0.1.0", "path": "wheels/" + wheel.name, "bytes": wheel.stat().st_size, "sha256": stager.sha_file(wheel)}
            receipt = source / "source-wheels.json"
            receipt.write_text(json.dumps({"status": "complete", "wheels": [record]}), encoding="utf-8")
            data = json.loads(manifest.read_bytes())
            data.update({"sourceWheels": [record], "sourceWheelsReceiptSha256": stager.sha_file(receipt), "sources": []})
            for group in sorted(stager.GROUPS):
                locals_ = ["proxy-tools"] if group == "python-tools" else []
                data["sources"].append({"id": group, "localWheelDependencies": locals_})
                relative = f"package-inputs/{group}/requirements.resolved.txt"
                file = root / relative
                file.write_text("example==1.0\n" + ("proxy-tools==0.1.0\n" if locals_ else ""), encoding="utf-8")
                data["files"].append({"id": group, "file": file.name, "path": relative, "bytes": file.stat().st_size, "sha256": stager.sha_file(file)})
            manifest.write_text(json.dumps(data), encoding="utf-8")
            contract["packageInputsSha256"] = stager.sha_file(manifest)
            (pins / "groups.json").write_text(json.dumps(contract), encoding="utf-8")
            prepared = stager.validate_plan(pins, manifest, cache)[0]
            with self.assertRaisesRegex(ValueError, "required"):
                stager.attach_source_wheels(copy.deepcopy(prepared), manifest, None)
            selected, _ = stager.attach_source_wheels(copy.deepcopy(prepared), manifest, source)
            self.assertEqual(len(selected), 1)
            bad = copy.deepcopy(prepared)
            next(group for group in bad if group["id"] == "python-tools")["pins"]["missing-extra"] = "1.0"
            with self.assertRaisesRegex(ValueError, "full dependency resolution"):
                stager.attach_source_wheels(bad, manifest, source)
            wheel.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "wheel bytes"):
                stager.attach_source_wheels(copy.deepcopy(prepared), manifest, source)

    def test_installed_metadata_closure_checks_selected_extras(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "app-1.0.dist-info"
            app.mkdir()
            (app / "METADATA").write_text('Metadata-Version: 2.1\nName: app\nVersion: 1.0\nRequires-Dist: image>=2; extra == "vision"\n', encoding="utf-8")
            self.assertEqual(project_build.audit_dependencies(root, [{"name": "app", "extras": []}]), {"app": "1.0"})
            with self.assertRaisesRegex(ValueError, "Unsatisfied"):
                project_build.audit_dependencies(root, [{"name": "app", "extras": ["vision"]}])
            dependency = root / "image-2.0.dist-info"
            dependency.mkdir()
            (dependency / "METADATA").write_text('Metadata-Version: 2.1\nName: image\nVersion: 2.0\n', encoding="utf-8")
            self.assertEqual(project_build.audit_dependencies(root, [{"name": "app", "extras": ["vision"]}])["image"], "2.0")

    def test_only_exact_unique_pins(self):
        self.assertEqual(pin.read_pins("# retained\nFoo_bar==1.2.3\n"), {"foo-bar": "1.2.3"})
        for text in ("foo>=1", "foo==1; sys_platform=='win32'", "foo==1\nfoo==2", "--index-url https://example.com", "foo @ https://example.com/a.whl", ""):
            with self.subTest(text=text), self.assertRaises(ValueError):
                pin.read_pins(text)

    def metadata(self):
        filename = "example-1.0-py3-none-any.whl"
        return {"info": {"name": "example", "version": "1.0"}, "urls": [{"packagetype": "bdist_wheel", "yanked": False, "filename": filename, "url": "https://files.pythonhosted.org/packages/a/" + filename, "digests": {"sha256": "a" * 64}, "size": 42, "requires_python": ">=3.10"}]}

    def choose(self, metadata):
        return pin.choose_wheel(metadata, "example", "1.0", list(pin.sys_tags()), pin.Version(platform.python_version()))

    def test_binary_compatibility_and_yanked_versions(self):
        self.assertEqual(self.choose(self.metadata())["size"], 42)
        for field, value in (("yanked", True), ("packagetype", "sdist"), ("requires_python", ">=4"), ("filename", "example-1.0-cp313-cp313-manylinux_2_17_x86_64.whl")):
            metadata = self.metadata()
            metadata["urls"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.choose(metadata)

    def test_publisher_identity_url_hash_and_size(self):
        for field, value in (("filename", "../example.whl"), ("filename", "wrong-1.0-py3-none-any.whl"), ("url", "https://user:secret@files.pythonhosted.org/a.whl"), ("url", "https://example.com/example-1.0-py3-none-any.whl"), ("size", 0), ("digests", {"sha256": "bad"})):
            metadata = self.metadata()
            metadata["urls"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.choose(metadata)
        metadata = self.metadata()
        metadata["info"]["version"] = "2.0"
        with self.assertRaises(ValueError):
            self.choose(metadata)

    def fixture(self, root):
        pins, cache = root / "pins", root / "cache"
        pins.mkdir(); cache.mkdir()
        payload = b"a test wheel placeholder: validation must not execute it"
        sha = hashlib.sha256(payload).hexdigest()
        (cache / (sha + ".blob")).write_bytes(payload)
        filename = "example-1.0-py3-none-any.whl"
        artifact = {"id": "py-example", "role": "server", "usage": "runtime", "license": "NOASSERTION", "version": "1.0", "sha256": sha, "bytes": len(payload), "url": "https://files.pythonhosted.org/packages/a/" + filename}
        groups, files = [], []
        for group_id in sorted(stager.GROUPS):
            relative = f"package-inputs/{group_id}/requirements.txt"
            file = root / relative
            file.parent.mkdir(parents=True)
            data = b"example==1.0\n"
            file.write_bytes(data)
            source_sha = hashlib.sha256(data).hexdigest()
            files.append({"id": group_id, "file": "requirements.txt", "path": relative, "bytes": len(data), "sha256": source_sha})
            direct = f"package-inputs/{group_id}/requirements.in"
            (root / direct).write_bytes(data)
            files.append({"id": group_id, "file": "requirements.in", "path": direct, "bytes": len(data), "sha256": source_sha})
            groups.append({"id": group_id, "sourceRequirementsSha256": source_sha, "packages": [{"name": "example", "version": "1.0", "artifact": "py-example", "filename": filename, "sha256": sha}]})
            (pins / (group_id + ".txt")).write_text(f"example==1.0 --hash=sha256:{sha}\n", encoding="utf-8")
        manifest = root / "package-inputs.json"
        manifest.write_bytes(json.dumps({"schemaVersion": 1, "files": files}).encode())
        artifact_file = pins / "artifacts.json"
        artifact_file.write_bytes(json.dumps({"schemaVersion": 1, "artifacts": [artifact]}).encode())
        contract = {"schemaVersion": 1, "platform": "win_amd64", "python": platform.python_version(), "packageInputsSha256": stager.sha_file(manifest), "artifactManifestSha256": stager.sha_file(artifact_file), "groups": groups}
        (pins / "groups.json").write_text(json.dumps(contract), encoding="utf-8")
        return pins, manifest, cache, contract

    def test_full_plan_preserves_every_pin_and_rejects_requirement_injection(self):
        with tempfile.TemporaryDirectory(prefix="Harbor wheels ü ") as temporary:
            pins, manifest, cache, _ = self.fixture(Path(temporary))
            groups, artifacts, _ = stager.validate_plan(pins, manifest, cache)
            self.assertEqual(len(groups), 2)
            self.assertEqual(len(artifacts), 1)
            (pins / "python-tools.txt").write_text("--index-url https://example.com\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Hashed requirement text"):
                stager.validate_plan(pins, manifest, cache)

    def test_cache_corruption_and_original_pin_drift_fail_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            pins, manifest, cache, _ = self.fixture(Path(temporary))
            blob = next(cache.iterdir())
            blob.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "Cached wheel checksum"):
                stager.validate_plan(pins, manifest, cache)
        with tempfile.TemporaryDirectory() as temporary:
            pins, manifest, cache, _ = self.fixture(Path(temporary))
            (Path(temporary) / "package-inputs/python-tools/requirements.txt").write_text("example==2.0", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Original Python requirement hash"):
                stager.validate_plan(pins, manifest, cache)

    def test_changed_group_identity_and_manifest_hash_are_rejected(self):
        for mutation in ("version", "duplicate", "hash"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                pins, manifest, cache, contract = self.fixture(Path(temporary))
                if mutation == "version":
                    contract["groups"][0]["packages"][0]["version"] = "2.0"
                elif mutation == "duplicate":
                    contract["groups"][1] = copy.deepcopy(contract["groups"][0])
                else:
                    contract["artifactManifestSha256"] = "0" * 64
                (pins / "groups.json").write_text(json.dumps(contract), encoding="utf-8")
                with self.assertRaises(ValueError):
                    stager.validate_plan(pins, manifest, cache)

    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            sentinel = output / "keep.txt"
            sentinel.write_text("keep", encoding="utf-8")
            runtime = Path(sys.executable).parents[2]
            with self.assertRaisesRegex(ValueError, "output must be new"):
                stager.stage("unused", "unused", "unused", runtime, output)
            self.assertEqual(sentinel.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
