"""Install the reviewed wheel set offline into a new Portable staging root."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse

from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.version import Version

GROUPS = {"python-tools", "fastmcp-tools"}
SOURCE_GROUPS = {"serena", "pdf-tools", "duckdb", "markitdown", "excel", "word", "python-build"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular_path(value, directory=False):
    value = Path(value).absolute()
    for parent in reversed(value.parents):
        require(parent.is_dir() and not parent.is_symlink() and not parent.is_junction(), "Build paths cannot contain links")
    require(not value.is_symlink() and not value.is_junction(), "Build paths cannot contain links")
    require(value.is_dir() if directory else value.is_file(), "Expected a regular build input")
    return value


def sha_file(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_plan(pin_root, package_manifest, cache):
    pin_root = regular_path(pin_root, True)
    cache = regular_path(cache, True)
    package_manifest = regular_path(package_manifest)
    artifact_file = regular_path(pin_root / "artifacts.json")
    contract_file = regular_path(pin_root / "groups.json")
    artifact_bytes, contract_bytes, package_bytes = artifact_file.read_bytes(), contract_file.read_bytes(), package_manifest.read_bytes()
    artifacts, contract, package_inputs = map(json.loads, (artifact_bytes, contract_bytes, package_bytes))
    require(contract.get("schemaVersion") == artifacts.get("schemaVersion") == package_inputs.get("schemaVersion") == 1, "Unknown Python staging schema")
    require(contract.get("platform") == "win_amd64" and contract.get("python") == platform.python_version(), "Wheel set and staged Python version differ")
    require(contract.get("artifactManifestSha256") == hashlib.sha256(artifact_bytes).hexdigest(), "Wheel artifact manifest hash differs")
    require(contract.get("packageInputsSha256") == hashlib.sha256(package_bytes).hexdigest(), "Source package manifest hash differs")
    require(isinstance(artifacts.get("artifacts"), list) and 1 <= len(artifacts["artifacts"]) <= 256, "Invalid wheel count")
    by_id = {}
    for item in artifacts["artifacts"]:
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", item.get("id", "")) and item["id"] not in by_id, "Invalid or duplicate wheel ID")
        require(re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) and type(item.get("bytes")) is int and 0 < item["bytes"] <= 512 * 1024**2, "Invalid wheel digest or size")
        url = urlparse(item.get("url", ""))
        require(url.scheme == "https" and url.netloc == "files.pythonhosted.org" and not url.query and not url.fragment, "Wheel source must be the official public PyPI file host")
        blob = regular_path(cache / (item["sha256"] + ".blob"))
        require(blob.stat().st_size == item["bytes"] and sha_file(blob) == item["sha256"], "Cached wheel checksum/size differs")
        by_id[item["id"]] = {**item, "blob": blob}
    expected_groups = package_inputs.get("pythonGroups", sorted(GROUPS))
    require(isinstance(expected_groups, list) and expected_groups and all(isinstance(group, str) for group in expected_groups) and len(expected_groups) == len(set(expected_groups)) and set(expected_groups) <= GROUPS | SOURCE_GROUPS, "Unknown or duplicate Python group selection")
    require(isinstance(contract.get("groups"), list) and len(contract["groups"]) == len(expected_groups) and {group.get("id") for group in contract["groups"]} == set(expected_groups), "Expected the exact declared Python groups")
    prepared, used, wheel_names = [], set(), {}
    tags = set(sys_tags())
    for group in contract["groups"]:
        group_id = group["id"]
        originals = [item for item in package_inputs["files"] if item["id"] == group_id and item["file"] == "requirements.txt"]
        require(len(originals) == 1 and originals[0]["path"] == f"package-inputs/{group_id}/requirements.txt", "Expected one canonical original requirements file")
        source = regular_path(package_manifest.parent / originals[0]["path"])
        source_bytes = source.read_bytes()
        require(len(source_bytes) == originals[0]["bytes"] and hashlib.sha256(source_bytes).hexdigest() == originals[0]["sha256"] == group["sourceRequirementsSha256"], "Original Python requirement hash differs")
        pins = {}
        for line in source_bytes.decode("utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+_-]*)", line)
            require(match is not None, "Original requirements must contain only exact pins")
            name = canonicalize_name(match[1])
            require(name not in pins, "Duplicate original Python pin")
            pins[name] = match[2]
        require(isinstance(group.get("packages"), list) and len(group["packages"]) == len(pins), "Wheel group differs from original pins")
        expected, seen = [], set()
        for package in group["packages"]:
            name, version, filename = package.get("name", ""), package.get("version", ""), package.get("filename", "")
            require(name in pins and name not in seen and version == pins[name], "Wheel group changes or duplicates a captured version")
            seen.add(name)
            require(re.fullmatch(r"[A-Za-z0-9_.+!-]+\.whl", filename), "Unsafe wheel filename")
            wheel_name, wheel_version, _, wheel_tags = parse_wheel_filename(filename)
            require(wheel_name == name and wheel_version == Version(version) and bool(wheel_tags & tags), "Wheel identity/platform differs")
            artifact = by_id.get(package.get("artifact"))
            require(artifact and artifact["sha256"] == package.get("sha256") and artifact["version"] == version and urlparse(artifact["url"]).path.endswith("/" + filename), "Wheel artifact binding differs")
            require(filename.casefold() not in wheel_names or wheel_names[filename.casefold()] == artifact["sha256"], "Wheel filename collision")
            wheel_names[filename.casefold()] = artifact["sha256"]
            used.add(artifact["id"])
            expected.append(f"{name}=={version} --hash=sha256:{artifact['sha256']}")
        require(set(pins) == seen, "Wheel group omits captured dependencies")
        requirement_file = regular_path(pin_root / f"{group_id}.txt")
        lines = [line.strip() for line in requirement_file.read_text(encoding="utf-8").splitlines() if line.strip() and not line.lstrip().startswith("#")]
        require(lines == expected, "Hashed requirement text differs from the reviewed wheel set")
        direct_records = [item for item in package_inputs["files"] if item["id"] == group_id and item["file"] == "requirements.in"]
        require(len(direct_records) == 1 and direct_records[0]["path"] == f"package-inputs/{group_id}/requirements.in", "Expected canonical direct requirements for future maintenance")
        direct_file = regular_path(package_manifest.parent / direct_records[0]["path"])
        direct_bytes = direct_file.read_bytes()
        require(len(direct_bytes) == direct_records[0]["bytes"] and hashlib.sha256(direct_bytes).hexdigest() == direct_records[0]["sha256"], "Direct Python requirements hash differs")
        prepared.append({"id": group_id, "pins": pins, "packages": group["packages"], "requirements": requirement_file.read_bytes(), "originals": {"requirements.txt": source_bytes, "requirements.in": direct_bytes}})
    require(used == set(by_id), "Unreferenced wheel artifact")
    return prepared, by_id, {"groupsSha256": hashlib.sha256(contract_bytes).hexdigest(), "artifactsSha256": hashlib.sha256(artifact_bytes).hexdigest(), "packageInputsSha256": hashlib.sha256(package_bytes).hexdigest()}


def attach_source_wheels(prepared, package_manifest, source_wheels):
    inputs = json.loads(Path(package_manifest).read_bytes())
    declared = inputs.get("sourceWheels", [])
    if not declared:
        require(source_wheels is None, "Source wheels were not declared in the dependency contract")
        return [], None
    source_wheels = regular_path(source_wheels, True) if source_wheels is not None else None
    require(source_wheels is not None, "Reviewed source wheels are required by the dependency contract")
    receipt_file = regular_path(source_wheels / "source-wheels.json")
    require(sha_file(receipt_file) == inputs["sourceWheelsReceiptSha256"], "Source wheel receipt differs")
    receipt = json.loads(receipt_file.read_bytes())
    require(receipt.get("status") == "complete" and receipt["wheels"] == declared, "Source wheel identities differ")
    require(len(declared) == 1 and declared[0]["name"] == "proxy-tools" and declared[0]["version"] == "0.1.0", "Unreviewed source-built dependency")
    files = []
    for item in declared:
        file = regular_path(source_wheels / item["path"])
        require(file.is_relative_to(source_wheels) and file.stat().st_size == item["bytes"] and sha_file(file) == item["sha256"], "Source wheel bytes differ")
        name, version, _, tags = parse_wheel_filename(file.name)
        require(name == item["name"] and version == Version(item["version"]) and tags & set(sys_tags()), "Source wheel name/platform differs")
        files.append({**item, "file": file})
    used = set()
    for group in prepared:
        source = [entry for entry in inputs["sources"] if entry["id"] == group["id"]]
        require(len(source) == 1, "Missing source project dependency declaration")
        local = source[0].get("localWheelDependencies", [])
        require(len(local) == len(set(local)) and set(local) <= {item["name"] for item in files}, "Unknown local dependency")
        for name in local:
            item = next(item for item in files if item["name"] == name)
            require(name not in group["pins"], "Duplicate remote/local dependency")
            group["pins"][name] = item["version"]
            group["requirements"] += f"{name}=={item['version']} --hash=sha256:{item['sha256']}\n".encode()
            used.add(name)
        records = [item for item in inputs["files"] if item["id"] == group["id"] and item["file"] == "requirements.resolved.txt"]
        require(len(records) == 1 and records[0]["path"] == f"package-inputs/{group['id']}/requirements.resolved.txt", "Missing full source dependency resolution")
        resolved = regular_path(Path(package_manifest).parent / records[0]["path"])
        require(sha_file(resolved) == records[0]["sha256"] and resolved.stat().st_size == records[0]["bytes"], "Full dependency resolution bytes differ")
        pins = {}
        for line in resolved.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+_-]*)", line.strip())
            require(match is not None, "Full resolution must use exact pins")
            name = canonicalize_name(match[1])
            require(name not in pins, "Duplicate fully resolved dependency")
            pins[name] = match[2]
        require(pins == group["pins"], "Remote and source wheels do not cover the full dependency resolution")
        group["originals"]["requirements.resolved.txt"] = resolved.read_bytes()
    require(used == {item["name"] for item in files}, "Unused source-built wheel")
    return files, sha_file(receipt_file)


def stage(pin_root, package_manifest, cache, runtime, output, source_wheels=None):
    require(sys.platform == "win32" and platform.machine().lower() in ("amd64", "x86_64"), "This recipe targets Windows x64")
    runtime = regular_path(runtime, True)
    python = regular_path(runtime / "runtimes/python/python.exe")
    uv = regular_path(runtime / "runtimes/uv/uv.exe")
    require(Path(sys.executable).resolve() == python.resolve(), "Run this stager with the explicitly staged Python")
    output = Path(output).absolute()
    regular_path(output.parent, True)
    require(not output.exists(), "Python stage output must be new")
    for protected in (runtime, Path(pin_root).absolute(), Path(cache).absolute(), Path(package_manifest).absolute().parent):
        require(not output.is_relative_to(protected) and not protected.is_relative_to(output), "Python stage must be separate from its inputs and runtimes")
    prepared, artifacts, identities = validate_plan(pin_root, package_manifest, cache)
    built_wheels, source_receipt = attach_source_wheels(prepared, package_manifest, source_wheels)
    if source_wheels is not None:
        protected = Path(source_wheels).absolute()
        require(not output.is_relative_to(protected) and not protected.is_relative_to(output), "Stage overlaps source wheel inputs")
        identities["sourceWheelsReceiptSha256"] = source_receipt
    output.mkdir()
    marker = output / "PYTHON-STAGING-INCOMPLETE.json"
    marker.write_text('{"status":"in-progress"}\n', encoding="utf-8")
    home = output / "build-home"
    home.mkdir()
    temp = home / "temp"
    temp.mkdir()
    wheelhouse = output / "wheelhouse"
    wheelhouse.mkdir()
    report = {"schemaVersion": 1, "status": "in-progress", "python": platform.python_version(), "inputs": identities, "runtimes": {"pythonSha256": sha_file(python), "uvSha256": sha_file(uv)}, "groups": [], "scope": "Offline verified-wheel installation only. Component MCP acceptance, full assembly, licenses and separate-machine acceptance remain separate."}
    try:
        copied = set()
        for item in built_wheels:
            shutil.copyfile(item["file"], wheelhouse / item["file"].name)
            require(sha_file(wheelhouse / item["file"].name) == item["sha256"], "Source wheel changed while copying")
            copied.add(item["file"].name)
        for group in prepared:
            for package in group["packages"]:
                filename = package["filename"]
                if filename in copied:
                    continue
                artifact = artifacts[package["artifact"]]
                shutil.copyfile(artifact["blob"], wheelhouse / filename)
                require(sha_file(wheelhouse / filename) == artifact["sha256"], "Wheel changed while copying to stage")
                copied.add(filename)
        env = {key: value for key, value in os.environ.items() if key.upper() in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT")}
        env.update({"PATH": str(python.parent) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32"), "USERPROFILE": str(home), "HOME": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home), "TEMP": str(temp), "TMP": str(temp), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "UV_NO_PROGRESS": "1", "UV_PYTHON_DOWNLOADS": "never"})
        for group in prepared:
            destination = output / "packages" / group["id"]
            destination.mkdir(parents=True)
            requirements = destination / "requirements.lock.txt"
            requirements.write_bytes(group["requirements"])
            for filename, content in group["originals"].items():
                (destination / filename).write_bytes(content)
            target = destination / "python"
            args = [str(uv), "--no-config", "--offline", "--no-cache", "pip", "install", "--python", str(python), "--target", str(target), "--no-index", "--find-links", str(wheelhouse), "--require-hashes", "--no-build", "--keyring-provider", "disabled", "--link-mode", "copy", "--requirements", str(requirements)]
            result = subprocess.run(args, env=env, cwd=destination, text=True, capture_output=True, timeout=300, creationflags=subprocess.CREATE_NO_WINDOW)
            (destination / "install.log").write_text(result.stdout + result.stderr, encoding="utf-8")
            require(result.returncode == 0, f"Offline Python install failed for {group['id']}; see its install.log")
            installed = {}
            for distribution in importlib.metadata.distributions(path=[str(target)]):
                name = canonicalize_name(distribution.metadata["Name"])
                require(name not in installed, "Duplicate installed distribution")
                installed[name] = distribution.version
            require(installed == group["pins"], "Installed Python inventory differs from exact captured pins")
            files = []
            for file in sorted(target.rglob("*")):
                require(not file.is_symlink() and not file.is_junction(), "Installed wheel produced a linked path")
                if file.is_file():
                    files.append({"path": file.relative_to(target).as_posix(), "bytes": file.stat().st_size, "sha256": sha_file(file)})
            report["groups"].append({"id": group["id"], "installed": installed, "requirementsSha256": hashlib.sha256(group["requirements"]).hexdigest(), "files": files})
            print(json.dumps({"group": group["id"], "installed": len(installed), "files": len(files)}), flush=True)
        report["status"] = "complete"
        (output / "python-stage.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        marker.unlink()
        return report
    except BaseException as error:
        marker.write_text(json.dumps({"status": "failed", "error": str(error)}) + "\n", encoding="utf-8")
        raise


if __name__ == "__main__":
    extra = sys.argv[6:]
    if len(sys.argv) < 6 or extra and not (len(extra) == 2 and extra[0] == "--source-wheels"):
        raise SystemExit("Usage: staged-python -I -B stage-python-groups.py <pin-root> <package-inputs.json> <wheel-cache> <runtime-stage> <new-output> [--source-wheels <reviewed-wheel-stage>]")
    result = stage(*sys.argv[1:6], source_wheels=extra[1] if extra else None)
    print(json.dumps({"status": result["status"], "groups": len(result["groups"])}))
