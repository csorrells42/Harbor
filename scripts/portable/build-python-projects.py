"""Build reviewed source projects offline and combine them with pinned dependencies."""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.version import Version

spec = importlib.util.spec_from_file_location("wheel_stage", Path(__file__).with_name("stage-python-groups.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


def audit_dependencies(target, projects):
    distributions = {}
    for item in importlib.metadata.distributions(path=[str(target)]):
        name = canonicalize_name(item.metadata["Name"])
        stage.require(name not in distributions, "Duplicate installed distribution")
        distributions[name] = item
    extras = {item["name"]: set(item["extras"]) for item in projects}
    changed = True
    while changed:
        changed = False
        for name, item in distributions.items():
            for value in item.requires or []:
                req = Requirement(value)
                if req.marker and not any(req.marker.evaluate({"extra": extra}) for extra in {""} | extras.get(name, set())):
                    continue
                dependency = canonicalize_name(req.name)
                stage.require(dependency in distributions and Version(distributions[dependency].version) in req.specifier, f"Unsatisfied installed dependency: {name} requires {value}")
                wanted = extras.setdefault(dependency, set())
                if not req.extras <= wanted:
                    wanted.update(req.extras)
                    changed = True
    return {name: item.version for name, item in distributions.items()}


def build(inputs, source_stage, dependencies, runtime, output):
    inputs = stage.regular_path(inputs)
    source_stage, dependencies, runtime = [stage.regular_path(value, True) for value in (source_stage, dependencies, runtime)]
    python = stage.regular_path(runtime / "runtimes/python/python.exe")
    uv = stage.regular_path(runtime / "runtimes/uv/uv.exe")
    git = stage.regular_path(runtime / "runtimes/git/cmd/git.exe")
    stage.require(Path(sys.executable).resolve() == python.resolve(), "Use the explicitly staged Python")
    contract = json.loads(inputs.read_bytes())
    receipt_file = stage.regular_path(dependencies / "python-stage.json")
    receipt = json.loads(receipt_file.read_bytes())
    stage.require(contract.get("schemaVersion") == 1 and receipt.get("status") == "complete" and receipt["inputs"]["packageInputsSha256"] == stage.sha_file(inputs), "Dependency stage and project inputs differ")
    stage.require(receipt["runtimes"]["pythonSha256"] == stage.sha_file(python) and receipt["runtimes"]["uvSha256"] == stage.sha_file(uv), "Staged runtime bytes differ")
    groups = {group["id"]: group for group in receipt["groups"]}
    stage.require(len(groups) == 7 and set(groups) == stage.SOURCE_GROUPS, "Expected all six projects and build tools")
    for group in groups.values():
        root = stage.regular_path(dependencies / "packages" / group["id"] / "python", True)
        expected = {item["path"] for item in group["files"]}
        actual = set()
        for file in root.rglob("*"):
            stage.require(not file.is_symlink() and not file.is_junction(), "Linked dependency path")
            if file.is_file():
                actual.add(file.relative_to(root).as_posix())
        stage.require(expected == actual, "Dependency file membership differs")
        for item in group["files"]:
            file = stage.regular_path(root / item["path"])
            stage.require(file.is_relative_to(root) and file.stat().st_size == item["bytes"] and stage.sha_file(file) == item["sha256"], "Dependency file bytes differ")
    output = Path(output).absolute()
    stage.regular_path(output.parent, True)
    stage.require(not output.exists(), "Project build output must be new")
    for protected in (inputs.parent, source_stage, dependencies, runtime):
        stage.require(not output.is_relative_to(protected) and not protected.is_relative_to(output), "Project build overlaps inputs")
    base = {key: value for key, value in os.environ.items() if key.upper() in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT")}
    base.update({"PATH": str(python.parent) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32"), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PIP_NO_INDEX": "1", "PIP_CONFIG_FILE": os.devnull, "UV_OFFLINE": "1", "UV_PYTHON_DOWNLOADS": "never", "SOURCE_DATE_EPOCH": "1789776000", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})

    def run(args, cwd, env, timeout=180):
        return subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)

    projects = [item for item in contract["sources"] if item["id"] != "python-build"]
    stage.require(len(projects) == 6 and {item["id"] for item in projects} == stage.SOURCE_GROUPS - {"python-build"}, "Project list differs")
    for item in projects:
        root = stage.regular_path(source_stage / "packages" / item["id"], True)
        result = run([git, "-C", root, "rev-parse", "HEAD^{tree}"], root, base)
        stage.require(result.returncode == 0 and result.stdout.strip() == item["sourceTree"], "Project Git tree differs")
        result = run([git, "-C", root, "status", "--porcelain", "--untracked-files=all"], root, base)
        stage.require(result.returncode == 0 and not result.stdout.strip(), "Project source must be clean")
        for file in root.rglob("*"):
            stage.require(not file.is_symlink() and not file.is_junction(), "Linked project source path")
        for project in item["projects"]:
            source = stage.regular_path(root / project["path"], True)
            stage.require(source.is_relative_to(root) and stage.sha_file(stage.regular_path(source / "pyproject.toml")) == project["pyprojectSha256"], "Project metadata differs")
            if project["versionSource"]:
                version = stage.regular_path(source / project["versionSource"]["path"])
                stage.require(version.is_relative_to(source) and stage.sha_file(version) == project["versionSource"]["sha256"], "Project version source differs")
    output.mkdir()
    marker = output / "PYTHON-PROJECT-BUILD-INCOMPLETE.json"
    marker.write_text('{"status":"in-progress"}\n', encoding="utf-8")
    home = output / "build-home"
    home.mkdir()
    temp = home / "temp"
    temp.mkdir()
    base.update({"HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home), "TEMP": str(temp), "TMP": str(temp)})
    build_env = {**base, "PYTHONPATH": str(dependencies / "packages/python-build/python")}
    report = {"schemaVersion": 1, "status": "in-progress", "inputsSha256": stage.sha_file(inputs), "dependencyStageSha256": stage.sha_file(receipt_file), "groups": [], "scope": "Offline source builds with exact dependency inventory and metadata closure checks. Actual MCP acceptance, full relocation, licensing and clean-user acceptance remain separate."}
    for item in projects:
        group = item["id"]
        destination = output / "packages" / group
        shutil.copytree(source_stage / "packages" / group, destination)
        # Retain upstream history for maintenance; installed packages are generated.
        exclude = destination / ".git/info/exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as stream:
            stream.write("\n/python/\n")
        target = destination / "python"
        stage.require(not target.exists(), "Source unexpectedly includes a Python install")
        shutil.copytree(dependencies / "packages" / group / "python", target)
        wheels = output / "wheels" / group
        wheels.mkdir(parents=True)
        for project in item["projects"]:
            result = run([python, "-s", "-B", "-m", "build", "--wheel", "--no-isolation", "--outdir", wheels, destination / project["path"]], output, build_env)
            (wheels / (project["name"] + ".build.log")).write_text(result.stdout + result.stderr, encoding="utf-8")
            stage.require(result.returncode == 0, f"Offline project wheel build failed: {project['name']}")
        built, lines = [], []
        expected_projects = {project["name"]: project["version"] for project in item["projects"]}
        seen = set()
        for wheel in sorted(wheels.glob("*.whl")):
            name, version, _, tags = parse_wheel_filename(wheel.name)
            stage.require(name not in seen and name in expected_projects and version == Version(expected_projects[name]) and tags & set(stage.sys_tags()), "Built project wheel identity differs")
            seen.add(name)
            sha = stage.sha_file(wheel)
            built.append({"name": name, "version": str(version), "filename": wheel.name, "sha256": sha, "bytes": wheel.stat().st_size})
            lines.append(f"{name}=={version} --hash=sha256:{sha}")
        stage.require(seen == set(expected_projects), "Missing project wheel")
        requirements = wheels / "requirements.txt"
        requirements.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        result = run([uv, "--no-config", "--offline", "--no-cache", "pip", "install", "--python", python, "--target", target, "--no-index", "--find-links", wheels, "--no-deps", "--no-build", "--require-hashes", "--requirements", requirements, "--link-mode", "copy"], output, base)
        (wheels / "install.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        stage.require(result.returncode == 0, f"Built wheel installation failed: {group}")
        installed = audit_dependencies(target, item["projects"])
        expected = {**groups[group]["installed"], **expected_projects}
        stage.require(installed == expected, "Final installed project inventory differs")
        files = []
        for file in sorted(target.rglob("*")):
            stage.require(not file.is_symlink() and not file.is_junction(), "Linked project output")
            if file.is_file():
                files.append({"path": file.relative_to(target).as_posix(), "bytes": file.stat().st_size, "sha256": stage.sha_file(file)})
        report["groups"].append({"id": group, "sourceTree": item["sourceTree"], "wheels": built, "installed": installed, "files": files})
        print(json.dumps({"group": group, "packages": len(installed), "files": len(files), "dependencyClosure": "passed"}), flush=True)
    report["status"] = "complete"
    (output / "python-project-build.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    marker.unlink()
    return {"status": "complete", "projects": len(projects)}


if __name__ == "__main__":
    if len(sys.argv) != 6:
        raise SystemExit("Usage: staged-python -I -B build-python-projects.py <source-python-inputs.json> <source-stage> <dependency-stage> <runtime-stage> <new-output>")
    print(json.dumps(build(*sys.argv[1:])))
