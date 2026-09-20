"""Build the explicitly reviewed source-only dependency with offline pinned tools."""
import email
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import zipfile

spec = importlib.util.spec_from_file_location("wheel_stage", Path(__file__).with_name("stage-python-groups.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

SOURCE_SHA = "ccb3751f529c047e2d8a58440d86b205303cf0fe8146f784d1cbcd94f0a28010"
MEMBERS = {"PKG-INFO", "proxy_tools/__init__.py", "proxy_tools.egg-info/dependency_links.txt", "proxy_tools.egg-info/not-zip-safe", "proxy_tools.egg-info/PKG-INFO", "proxy_tools.egg-info/SOURCES.txt", "proxy_tools.egg-info/top_level.txt", "README.rst", "setup.cfg", "setup.py"}


def extract_reviewed(archive, output):
    stage.require(stage.sha_file(archive) == SOURCE_SHA and archive.stat().st_size == 2978, "Unreviewed source archive")
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        stage.require(len(members) == 13, "Unexpected archive members")
        actual = set()
        for member in members:
            parts = PurePosixPath(member.name).parts
            stage.require(parts and parts[0] == "proxy_tools-0.1.0" and all(part not in ("", ".", "..") for part in parts) and "\\" not in member.name, "Unsafe source archive path")
            stage.require(member.isdir() or member.isfile(), "Source archive contains a link or special file")
            if member.isfile():
                relative = "/".join(parts[1:])
                stage.require(relative in MEMBERS and relative not in actual and 0 <= member.size <= 16384, "Unexpected source file")
                actual.add(relative)
        stage.require(actual == MEMBERS, "Missing source file")
        output.mkdir()
        for member in members:
            if member.isfile():
                file = output.joinpath(*PurePosixPath(member.name).parts[1:])
                file.parent.mkdir(parents=True, exist_ok=True)
                with file.open("xb") as target:
                    target.write(tar.extractfile(member).read())


def build(manifest, cache, runtime, build_stage, output):
    manifest, cache = stage.regular_path(manifest), stage.regular_path(cache, True)
    runtime, build_stage = stage.regular_path(runtime, True), stage.regular_path(build_stage, True)
    python = stage.regular_path(runtime / "runtimes/python/python.exe")
    stage.require(Path(sys.executable).resolve() == python.resolve(), "Use the staged Python")
    plan = json.loads(manifest.read_bytes())
    stage.require(plan.get("schemaVersion") == 1 and len(plan["artifacts"]) == 1 and plan["artifacts"][0]["id"] == "proxy-tools-source" and plan["artifacts"][0]["sha256"] == SOURCE_SHA, "Unreviewed source dependency plan")
    archive = stage.regular_path(cache / (SOURCE_SHA + ".blob"))
    receipt_file = stage.regular_path(build_stage / "python-stage.json")
    receipt = json.loads(receipt_file.read_bytes())
    stage.require(receipt.get("status") == "complete" and receipt["runtimes"]["pythonSha256"] == stage.sha_file(python), "Build runtime receipt differs")
    groups = [group for group in receipt["groups"] if group["id"] == "python-build"]
    stage.require(len(groups) == 1, "Missing pinned build tools")
    tools = stage.regular_path(build_stage / "packages/python-build/python", True)
    for item in groups[0]["files"]:
        file = stage.regular_path(tools / item["path"])
        stage.require(file.is_relative_to(tools) and stage.sha_file(file) == item["sha256"], "Pinned build tool bytes differ")
    output = Path(output).absolute()
    stage.regular_path(output.parent, True)
    stage.require(not output.exists(), "Source wheel output must be new")
    for protected in (manifest.parent, cache, runtime, build_stage):
        stage.require(not output.is_relative_to(protected) and not protected.is_relative_to(output), "Build output overlaps inputs")
    output.mkdir()
    marker = output / "SOURCE-WHEEL-BUILD-INCOMPLETE.json"
    marker.write_text('{"status":"in-progress"}\n', encoding="utf-8")
    source = output / "source"
    extract_reviewed(archive, source)
    home, wheels = output / "build-home", output / "wheels"
    home.mkdir(); wheels.mkdir()
    temp = home / "temp"
    temp.mkdir()
    env = {key: value for key, value in os.environ.items() if key.upper() in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT")}
    env.update({"PATH": str(python.parent) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32"), "PYTHONPATH": str(tools), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PIP_NO_INDEX": "1", "PIP_CONFIG_FILE": os.devnull, "UV_OFFLINE": "1", "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home), "TEMP": str(temp), "TMP": str(temp), "SOURCE_DATE_EPOCH": "1789776000"})
    result = subprocess.run([str(python), "-s", "-B", "-m", "build", "--wheel", "--no-isolation", "--outdir", str(wheels), str(source)], cwd=output, env=env, capture_output=True, text=True, timeout=180, creationflags=subprocess.CREATE_NO_WINDOW)
    (output / "build.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    stage.require(result.returncode == 0, "Offline source build failed; see build.log")
    built = list(wheels.glob("*.whl"))
    stage.require(len(built) == 1 and built[0].name == "proxy_tools-0.1.0-py3-none-any.whl", "Unexpected built wheel")
    with zipfile.ZipFile(built[0]) as wheel:
        names = wheel.namelist()
        stage.require(len(names) == len(set(names)) and all(not name.startswith("/") and ".." not in PurePosixPath(name).parts and "\\" not in name for name in names), "Unsafe wheel paths")
        metadata = email.message_from_bytes(wheel.read("proxy_tools-0.1.0.dist-info/METADATA"))
        stage.require(metadata["Name"] in ("proxy-tools", "proxy_tools") and metadata["Version"] == "0.1.0" and not metadata.get_all("Requires-Dist"), "Built wheel metadata differs")
        stage.require(wheel.read("proxy_tools/__init__.py") == (source / "proxy_tools/__init__.py").read_bytes(), "Built module differs from reviewed source")
    record = {"schemaVersion": 1, "status": "complete", "sourceManifestSha256": stage.sha_file(manifest), "sourceSha256": SOURCE_SHA, "buildToolsReceiptSha256": stage.sha_file(receipt_file), "pythonSha256": stage.sha_file(python), "wheels": [{"name": "proxy-tools", "version": "0.1.0", "path": "wheels/" + built[0].name, "bytes": built[0].stat().st_size, "sha256": stage.sha_file(built[0])}], "scope": "Offline wheel built from the exact reviewed source using pinned build tools. Runtime and license acceptance remain separate."}
    (output / "source-wheels.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8", newline="\n")
    marker.unlink()
    return record


if __name__ == "__main__":
    if len(sys.argv) != 6:
        raise SystemExit("Usage: staged-python -I -B build-python-source-deps.py <source-inputs.json> <cache> <runtime-stage> <build-tools-stage> <new-output>")
    print(json.dumps(build(*sys.argv[1:])))
