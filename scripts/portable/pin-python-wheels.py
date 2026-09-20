"""Capture compatible PyPI wheel identities for the reviewed Windows CPython pins.

Run with the staged CPython (including its pinned pip); no packages are installed.
The output is a new directory to review and check in, not an automatic upgrade.
"""
import hashlib
import json
from pathlib import Path
import platform
import re
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.version import Version
from pip._vendor.packaging.specifiers import SpecifierSet

GROUPS = ("python-tools", "fastmcp-tools")
SOURCE_GROUPS = ("serena", "pdf-tools", "duckdb", "markitdown", "excel", "word", "python-build")


def selected_groups(manifest):
    groups = manifest.get("pythonGroups", list(GROUPS))
    if not isinstance(groups, list) or not groups or not all(isinstance(group, str) for group in groups) or len(groups) != len(set(groups)) or not set(groups) <= set(GROUPS + SOURCE_GROUPS):
        raise ValueError("Expected unique declared Python groups from the release allowlist")
    return groups


def read_pins(text):
    pins = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+_-]*)", line)
        if not match:
            raise ValueError("Only exact unmarked package==version pins are supported")
        name, version = canonicalize_name(match[1]), match[2]
        Version(version)
        if name in pins:
            raise ValueError("Duplicate Python package pin")
        pins[name] = version
    if not 1 <= len(pins) <= 256:
        raise ValueError("Expected 1-256 Python pins")
    return pins


def choose_wheel(metadata, name, version, tags, python_version):
    if canonicalize_name(metadata.get("info", {}).get("name", "")) != name or Version(metadata["info"]["version"]) != Version(version):
        raise ValueError("PyPI metadata identity differs from the exact pin")
    ranks = {tag: i for i, tag in enumerate(tags)}
    candidates = []
    for item in metadata.get("urls", []):
        if item.get("packagetype") != "bdist_wheel" or item.get("yanked"):
            continue
        filename = item.get("filename", "")
        if not re.fullmatch(r"[A-Za-z0-9_.+!-]+\.whl", filename):
            raise ValueError("Unsafe wheel filename")
        wheel_name, wheel_version, _, wheel_tags = parse_wheel_filename(filename)
        if wheel_name != name or wheel_version != Version(version):
            raise ValueError("Wheel identity differs from the exact pin")
        compatible = [ranks[tag] for tag in wheel_tags if tag in ranks]
        if not compatible or item.get("requires_python") and python_version not in SpecifierSet(item["requires_python"]):
            continue
        url = urlparse(item["url"])
        if url.scheme != "https" or url.netloc != "files.pythonhosted.org" or url.query or url.fragment or not url.path.endswith("/" + filename):
            raise ValueError("Wheel must use its exact public PyPI file URL")
        sha = item.get("digests", {}).get("sha256", "")
        if not re.fullmatch(r"[a-f0-9]{64}", sha) or not isinstance(item.get("size"), int) or not 0 < item["size"] <= 512 * 1024**2:
            raise ValueError("Wheel requires bounded size and publisher SHA-256")
        candidates.append((min(compatible), filename, item))
    if not candidates:
        raise ValueError(f"No non-yanked compatible binary wheel for {name}=={version}")
    return min(candidates, key=lambda entry: (entry[0], entry[1]))[2]


def capture(manifest_file, output):
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64") or sys.version_info[:2] != (3, 13):
        raise ValueError("Use the staged Windows x64 CPython 3.13")
    manifest_file, output = Path(manifest_file).resolve(), Path(output).absolute()
    if output.exists():
        raise FileExistsError("Wheel pin output must be new")
    manifest_bytes = manifest_file.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unknown package manifest schema")
    prepared = []
    for group in selected_groups(manifest):
        records = [item for item in manifest["files"] if item["id"] == group and item["file"] == "requirements.txt"]
        if len(records) != 1 or records[0]["path"] != f"package-inputs/{group}/requirements.txt":
            raise ValueError("Expected one canonical requirements input")
        record = records[0]
        source = manifest_file.parent / record["path"]
        if source.is_symlink():
            raise ValueError("Linked requirement inputs are not supported")
        data = source.read_bytes()
        if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("Captured requirements hash/size differs")
        prepared.append((group, record["sha256"], read_pins(data.decode("utf-8"))))
    tags, artifacts, packages, groups = list(sys_tags()), {}, {}, []
    for group, source_hash, pins in prepared:
        members = []
        for name, version in pins.items():
            key = (name, version)
            if key not in packages:
                endpoint = f"https://pypi.org/pypi/{name}/{version}/json"
                request = Request(endpoint, headers={"User-Agent": "Harbor-Portable-Wheel-Pinning/1"})
                with urlopen(request, timeout=30) as response:
                    if response.url != endpoint:
                        raise ValueError("Unexpected PyPI metadata redirect")
                    data = response.read(8 * 1024**2 + 1)
                if len(data) > 8 * 1024**2:
                    raise ValueError("PyPI metadata exceeds bound")
                item = choose_wheel(json.loads(data), name, version, tags, Version(platform.python_version()))
                sha = item["digests"]["sha256"]
                artifact_id = f"py-{name[:40]}-{sha[:16]}"
                artifacts[artifact_id] = {"id": artifact_id, "role": "server", "version": version, "usage": "runtime", "url": item["url"], "bytes": item["size"], "sha256": sha, "license": "NOASSERTION"}
                packages[key] = {"name": name, "version": version, "artifact": artifact_id, "filename": item["filename"], "sha256": sha, "metadataUrl": endpoint, "metadataSha256": hashlib.sha256(data).hexdigest()}
                print(f"Pinned {name}=={version}: {item['filename']}", flush=True)
            members.append(packages[key])
        groups.append({"id": group, "sourceRequirementsSha256": source_hash, "packages": members})
    # Resolve every pin before creating any output. Originals are never rewritten.
    output.mkdir()
    artifact_manifest = {"schemaVersion": 1, "release": "python-cp313-win-amd64", "artifacts": list(artifacts.values())}
    contract = {"schemaVersion": 1, "python": platform.python_version(), "platform": "win_amd64", "packageInputsSha256": hashlib.sha256(manifest_bytes).hexdigest(), "artifactManifestSha256": hashlib.sha256((json.dumps(artifact_manifest, indent=2) + "\n").encode()).hexdigest(), "scope": "Exact compatible PyPI wheel identities. License review, acquisition, offline staging and runtime acceptance are separate gates.", "groups": groups}
    (output / "artifacts.json").write_text(json.dumps(artifact_manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    (output / "groups.json").write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8", newline="\n")
    for group in groups:
        lines = ["# Windows x64 CPython 3.13 wheels; preserve exact captured dependency versions."]
        lines += [f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}" for p in group["packages"]]
        (output / f"{group['id']}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return {"artifacts": len(artifacts), "groups": [{"id": g["id"], "packages": len(g["packages"])} for g in groups]}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: staged-python -I -B pin-python-wheels.py <package-inputs.json> <new-pin-directory>")
    print(json.dumps(capture(*sys.argv[1:])))
