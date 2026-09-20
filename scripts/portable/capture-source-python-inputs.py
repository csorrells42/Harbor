"""Resolve source-project runtime requirements without executing upstream builds.

This explicit online capture step writes a new reviewable dependency input set.
Artifact pinning, offline installation and source wheel building are later gates.
"""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import Version

spec = importlib.util.spec_from_file_location("wheel_stage", Path(__file__).with_name("stage-python-groups.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

PROFILES = [
    ("serena", [(".", [])], []),
    ("pdf-tools", [(".", ["forms", "markdown"])], ["pypandoc_binary", "fastmcp<3", "mcp<2"]),
    ("duckdb", [(".", [])], []),
    ("markitdown", [("packages/markitdown", ["all"]), ("packages/markitdown-mcp", [])], []),
    ("excel", [(".", [])], ["mcp<2"]),
    ("word", [(".", [])], ["mcp<2"]),
]


def project_version(root, metadata):
    project = metadata["project"]
    stage.require(set(project.get("dynamic", [])) <= {"version"}, "Dynamic dependencies require explicit review")
    if "version" in project:
        return str(Version(project["version"])), None
    relative = metadata["tool"]["hatch"]["version"]["path"]
    source = stage.regular_path(root / relative)
    stage.require(source.is_relative_to(root), "Version source escapes project")
    values = []
    for node in ast.parse(source.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
            values.append(ast.literal_eval(node.value))
    stage.require(len(values) == 1 and isinstance(values[0], str), "Expected one static version assignment")
    return str(Version(values[0])), {"path": relative, "sha256": stage.sha_file(source)}


def project_requirements(root, extras):
    file = stage.regular_path(root / "pyproject.toml")
    metadata = tomllib.loads(file.read_text(encoding="utf-8"))
    stage.require(metadata["build-system"]["build-backend"] == "hatchling.build", "Unreviewed project build backend")
    stage.require(metadata["build-system"]["requires"] == ["hatchling"], "Unreviewed build backend requirements")
    version, version_source = project_version(root, metadata)
    direct = list(metadata["project"].get("dependencies", []))
    for extra in extras:
        direct.extend(metadata["project"]["optional-dependencies"][extra])
    for value in direct:
        stage.require(Requirement(value).url is None, "Direct URL dependencies require separate source capture")
    return direct, {"name": canonicalize_name(metadata["project"]["name"]), "version": version, "extras": extras,
                    "pyprojectSha256": stage.sha_file(file), "versionSource": version_source, "buildBackend": "hatchling.build"}


def capture(source_manifest, source_root, runtime, output, build_tools_only=False, source_wheels=None):
    source_manifest = stage.regular_path(source_manifest)
    source_root, runtime = stage.regular_path(source_root, True), stage.regular_path(runtime, True)
    python = stage.regular_path(runtime / "runtimes/python/python.exe")
    uv = stage.regular_path(runtime / "runtimes/uv/uv.exe")
    git = stage.regular_path(runtime / "runtimes/git/cmd/git.exe")
    stage.require(Path(sys.executable).resolve() == python.resolve(), "Run with the explicitly staged Python")
    output = Path(output).absolute()
    stage.regular_path(output.parent, True)
    stage.require(not output.exists(), "Source dependency capture output must be new")
    for protected in (source_manifest.parent, source_root, runtime):
        stage.require(not output.is_relative_to(protected) and not protected.is_relative_to(output), "Capture must be separate from sources and runtimes")
    sources = json.loads(source_manifest.read_bytes())
    stage.require(sources.get("schemaVersion") == 1, "Unknown source manifest schema")
    local_wheels, wheel_directory, wheel_receipt_sha = [], None, None
    if source_wheels is not None:
        source_wheels = stage.regular_path(source_wheels, True)
        wheel_receipt = stage.regular_path(source_wheels / "source-wheels.json")
        local = json.loads(wheel_receipt.read_bytes())
        source_inputs = Path(__file__).with_name("python-source-inputs.windows-x64.json")
        stage.require(local.get("schemaVersion") == 1 and local.get("status") == "complete" and local["sourceManifestSha256"] == stage.sha_file(source_inputs), "Local source wheel provenance differs")
        stage.require(len(local["wheels"]) == 1 and local["wheels"][0]["name"] == "proxy-tools" and local["wheels"][0]["version"] == "0.1.0", "Unreviewed local source dependency")
        for wheel in local["wheels"]:
            file = stage.regular_path(source_wheels / wheel["path"])
            stage.require(file.is_relative_to(source_wheels) and stage.sha_file(file) == wheel["sha256"] and file.stat().st_size == wheel["bytes"], "Local source wheel bytes differ")
        local_wheels = local["wheels"]
        wheel_directory, wheel_receipt_sha = source_wheels / "wheels", stage.sha_file(wheel_receipt)
    env = {key: value for key, value in os.environ.items() if key.upper() in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT")}
    env.update({"PATH": str(python.parent) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32"), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "UV_PYTHON_DOWNLOADS": "never", "UV_NO_PROGRESS": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})

    def git_read(root, *args):
        result = subprocess.run([str(git), "-c", "core.hooksPath=NUL", "-C", str(root), *args], env=env, capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        stage.require(result.returncode == 0, "Cannot verify captured Git source")
        return result.stdout.strip()

    prepared = []
    for group, projects, constraints in ([] if build_tools_only else PROFILES):
        matches = [item for item in sources["components"] if item["id"] == group]
        stage.require(len(matches) == 1, "Missing or duplicate source component")
        root = stage.regular_path(source_root / "packages" / group, True)
        stage.require(git_read(root, "rev-parse", "HEAD^{tree}") == matches[0]["patchedTree"], "Source Git tree differs from reviewed revision")
        stage.require(not git_read(root, "status", "--porcelain", "--untracked-files=all"), "Source worktree must be clean")
        direct, records = list(constraints), []
        for relative, extras in projects:
            requirements, record = project_requirements(stage.regular_path(root / relative, True), extras)
            direct.extend(requirements)
            records.append({"path": relative, **record})
        local = {record["name"]: record for record in records}
        remote = []
        for value in direct:
            req = Requirement(value)
            if canonicalize_name(req.name) in local:
                built = local[canonicalize_name(req.name)]
                stage.require(not req.marker and Version(built["version"]) in req.specifier and set(req.extras) <= set(built["extras"]), "Local project dependency is not satisfied by selected source")
            else:
                remote.append(value)
        prepared.append({"id": group, "requirements": sorted(set(remote)), "sourceTree": matches[0]["patchedTree"], "projects": records})
    prepared.append({"id": "python-build", "requirements": ["build", "hatchling", "setuptools", "wheel"], "projects": []})
    output.mkdir()
    marker = output / "SOURCE-PYTHON-CAPTURE-INCOMPLETE.json"
    marker.write_text('{"status":"in-progress"}\n', encoding="utf-8")
    home = output / "build-home"
    home.mkdir()
    temp = home / "temp"
    temp.mkdir()
    env.update({"USERPROFILE": str(home), "HOME": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home), "TEMP": str(temp), "TMP": str(temp)})
    files = []
    for group in prepared:
        destination = output / "package-inputs" / group["id"]
        destination.mkdir(parents=True)
        direct = destination / "requirements.in"
        direct.write_text("# Reviewed source-project dependencies; local projects are built separately.\n" + "\n".join(group["requirements"]) + "\n", encoding="utf-8", newline="\n")
        target = destination / "requirements.txt"
        args = [str(uv), "--no-config", "--no-cache", "pip", "compile", "--python", str(python), "--default-index", "https://pypi.org/simple", "--keyring-provider", "disabled", "--no-build", "--no-header", "--no-annotate", "--output-file", str(target), str(direct)]
        if wheel_directory:
            args.extend(["--find-links", str(wheel_directory)])
        result = subprocess.run(args, env=env, cwd=destination, capture_output=True, text=True, timeout=600, creationflags=subprocess.CREATE_NO_WINDOW)
        (destination / "resolve.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        stage.require(result.returncode == 0, f"Dependency resolution failed for {group['id']}; see resolve.log")
        # The later artifact contract deliberately only accepts concrete platform pins.
        target.write_text(target.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
        resolved = destination / "requirements.resolved.txt"
        resolved.write_bytes(target.read_bytes())
        remaining, built = [], []
        for line in target.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                remaining.append(line)
                continue
            req = Requirement(line)
            matches = [wheel for wheel in local_wheels if wheel["name"] == canonicalize_name(req.name)]
            if matches:
                stage.require(str(req.specifier) == "==" + matches[0]["version"] and not req.marker and not req.extras and not req.url, "Local source dependency version differs")
                built.append(matches[0]["name"])
            else:
                remaining.append(line)
        target.write_text("\n".join(remaining) + "\n", encoding="utf-8", newline="\n")
        group["localWheelDependencies"] = built
        for file in (direct, target, resolved):
            files.append({"id": group["id"], "file": file.name, "path": file.relative_to(output).as_posix(), "bytes": file.stat().st_size, "sha256": stage.sha_file(file)})
        print(json.dumps({"group": group["id"], "status": "resolved"}), flush=True)
    for group in prepared:
        if group["id"] != "python-build":
            stage.require(not git_read(source_root / "packages" / group["id"], "status", "--porcelain", "--untracked-files=all"), "Source changed during capture")
    contract = {"schemaVersion": 1, "pythonGroups": [group["id"] for group in prepared], "sourceManifestSha256": stage.sha_file(source_manifest), "sourceWheelsReceiptSha256": wheel_receipt_sha, "sourceWheels": local_wheels, "sources": prepared, "files": files,
                "scope": "Resolved dependency versions only. Compatible artifacts, offline source builds, licenses and MCP acceptance require separate evidence."}
    (output / "package-inputs.json").write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8", newline="\n")
    marker.unlink()
    return {"status": "resolved", "groups": len(prepared)}


if __name__ == "__main__":
    extra = sys.argv[5:]
    if len(sys.argv) < 5 or extra and extra != ["--build-tools-only"] and not (len(extra) == 2 and extra[0] == "--source-wheels"):
        raise SystemExit("Usage: staged-python -I -B capture-source-python-inputs.py <source-revisions.json> <source-stage> <runtime-stage> <new-output> [--build-tools-only | --source-wheels <reviewed-wheel-stage>]")
    print(json.dumps(capture(*sys.argv[1:5], build_tools_only=extra == ["--build-tools-only"], source_wheels=extra[1] if len(extra) == 2 else None)))
