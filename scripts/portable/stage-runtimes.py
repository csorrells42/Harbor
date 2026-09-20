"""Offline runtime staging. Python 3.13+ is a build prerequisite, never a runtime dependency."""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import tarfile
import zipfile

MAX_FILES = 100000
MAX_FILE_BYTES = 512 * 1024**2

def require(condition, message):
    if not condition:
        raise ValueError(message)

def relative_path(value, allow_empty=False):
    require(isinstance(value, str), 'Archive path must be a string')
    if allow_empty and value == '':
        return value
    parts = value.split('/')
    require(len(value) <= 1024 and all(part and part not in ('.', '..') and not re.search(r'[\\:<>"|?*\x00-\x1f]', part)
        and not part.endswith(('.', ' ')) and not re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I)
        for part in parts), 'Unsafe or non-portable archive path')
    return value

def assert_real_directory(directory):
    directory = pathlib.Path(os.path.abspath(directory))
    for current in [*reversed(directory.parents), directory]:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not current.is_symlink() and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Stage/cache ancestors must be real directories without links')
    return directory

def regular_file(file):
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and not file.is_symlink() and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Input must be a regular file without links')
    return info

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def validated_plans(inputs, layout):
    require(inputs.get('schemaVersion') == 1 and layout.get('schemaVersion') == 1, 'Unsupported input/layout version')
    require(isinstance(inputs.get('release'), str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}', inputs['release']), 'Invalid release identifier')
    require(isinstance(inputs.get('artifacts'), list) and 0 < len(inputs['artifacts']) <= 256, 'Invalid input count')
    artifacts = {}
    for item in inputs['artifacts']:
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', item.get('id', '')) and item['id'] not in artifacts, 'Invalid or duplicate input ID')
        require(re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')), 'Input digest required')
        require(type(item.get('bytes')) is int and 0 < item['bytes'] <= 8*1024**3, 'Exact input size required')
        require(isinstance(item.get('version'), str) and item['version'] and item.get('usage') in ('build', 'runtime', 'both') and isinstance(item.get('license'), str) and item['license'], 'Version, usage and license metadata required')
        artifacts[item['id']] = item
    require(isinstance(layout.get('components'), list) and 0 < len(layout['components']) <= 256, 'Invalid layout count')
    selected, targets, result = set(), set(), []
    for component in layout['components']:
        key = component.get('artifact')
        require(key in artifacts and key not in selected, 'Missing or duplicate layout input')
        selected.add(key)
        target = relative_path(component.get('target'))
        require(re.fullmatch(r'runtimes/(?:browsers/)?[a-z0-9][a-z0-9_-]{0,63}', target), 'Invalid runtime target')
        require(not any(target == prior or target.startswith(prior + '/') or prior.startswith(target + '/') for prior in targets), 'Runtime targets must be unique and must not overlap')
        targets.add(target)
        prefix = relative_path(component.get('stripPrefix', ''), allow_empty=True)
        require(component.get('format') in ('zip', 'tar.gz'), 'Unsupported archive format')
        limit = component.get('maxUnpackedBytes')
        require(type(limit) is int and 0 < limit <= 2*1024**3, 'Bounded unpacked size required')
        relocations = component.get('relocate', {})
        require(isinstance(relocations, dict) and len(relocations) <= 32, 'Invalid relocations')
        for source, destination in relocations.items():
            relative_path(source); relative_path(destination)
        result.append((artifacts[key], {**component, 'stripPrefix': prefix, 'relocate': relocations}))
    require(selected == set(artifacts), 'Layout must account for every declared input')
    require(sum(component['maxUnpackedBytes'] for _, component in result) <= 8*1024**3, 'Total staging bound exceeds 8 GiB')
    return result

def members(archive, format_name):
    owner = zipfile.ZipFile(archive) if format_name == 'zip' else tarfile.open(archive, 'r:gz')
    try:
        entries = []
        if format_name == 'zip':
            require(len(owner.infolist()) <= MAX_FILES, 'Archive entry limit exceeded')
            for info in owner.infolist():
                mode = info.external_attr >> 16
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and not info.external_attr & 0x400, 'Archive links and special files are unsupported')
                require(not info.flag_bits & 1, 'Encrypted archive entries are unsupported')
                entries.append((info.filename, info.is_dir(), info.file_size, info))
            return owner, entries, owner.open
        for info in owner:
            require(info.isfile() or info.isdir(), 'Archive links and special files are unsupported')
            entries.append((info.name, info.isdir(), info.size, info))
            require(len(entries) <= MAX_FILES, 'Archive entry limit exceeded')
        return owner, entries, owner.extractfile
    except BaseException:
        owner.close()
        raise

def stage_runtimes(inputs, layout, cache, output):
    components = validated_plans(inputs, layout)
    cache = assert_real_directory(cache)
    output = pathlib.Path(os.path.abspath(output))
    assert_real_directory(output.parent)
    require(not output.exists() and not output.is_symlink(), 'Output must be a new directory')
    # Check all compressed inputs before creating output or expanding any archive.
    for artifact, _ in components:
        archive = cache / (artifact['sha256'] + '.blob')
        require(regular_file(archive).st_size == artifact['bytes'] and digest(archive) == artifact['sha256'], 'Input size/checksum mismatch: ' + artifact['id'])
    output.mkdir()
    marker = output / 'STAGING-INCOMPLETE.json'
    marker.write_text(json.dumps({'status': 'incomplete', 'pid': os.getpid()}), encoding='utf8')
    receipt = {'schemaVersion': 1, 'kind': 'offline-runtime-stage', 'status': 'incomplete', 'release': inputs['release'], 'components': []}
    try:
        for artifact, component in components:
            archive = cache / (artifact['sha256'] + '.blob')
            before = regular_file(archive)
            owner, entries, reader = members(archive, component['format'])
            with owner:
                require(len(entries) <= MAX_FILES, 'Archive entry limit exceeded')
                selected, seen, total, spelling = [], set(), 0, {}
                prefix = component['stripPrefix']
                for name, is_dir, size, info in entries:
                    name = relative_path(name.rstrip('/') if is_dir else name)
                    if prefix and name == prefix and is_dir:
                        continue
                    require(not prefix or name.startswith(prefix + '/'), 'Archive entry is outside declared prefix')
                    name = name[len(prefix)+1:] if prefix else name
                    name = component['relocate'].get(name, name)
                    relative_path(name)
                    require(name.casefold() not in seen, 'Case-colliding or duplicate archive paths')
                    seen.add(name.casefold())
                    parts = name.split('/')
                    for index in range(1, len(parts)+1):
                        portion = '/'.join(parts[:index])
                        require(spelling.get(portion.casefold(), portion) == portion, 'Case-colliding archive parent paths')
                        spelling[portion.casefold()] = portion
                    require(0 <= size <= MAX_FILE_BYTES, 'Archive member size exceeds bound')
                    if not is_dir:
                        total += size
                    require(total <= component['maxUnpackedBytes'], 'Archive expansion exceeds declared bound')
                    selected.append((name, is_dir, size, info))
                files = []
                for name, is_dir, size, info in selected:
                    target = output / component['target'] / name
                    # Every path is validated and all contents are created here; links are never extracted.
                    if is_dir:
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    actual, h = 0, hashlib.sha256()
                    with reader(info) as source, target.open('xb') as destination:
                        for block in iter(lambda: source.read(1024*1024), b''):
                            actual += len(block)
                            require(actual <= size, 'Expanded member exceeded declared size')
                            h.update(block); destination.write(block)
                    require(actual == size, 'Expanded member was truncated')
                    files.append({'path': target.relative_to(output).as_posix(), 'bytes': actual, 'sha256': h.hexdigest()})
                after = regular_file(archive)
                require((before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_ino), 'Archive changed during staging')
                require(digest(archive) == artifact['sha256'], 'Archive changed during staging')
                receipt['components'].append({'artifact': artifact['id'], 'version': artifact['version'], 'usage': artifact['usage'], 'license': artifact['license'], 'archiveSha256': artifact['sha256'], 'target': component['target'], 'bytes': total, 'files': files})
        receipt['status'] = 'complete'
        receipt['files'] = sum(len(component['files']) for component in receipt['components'])
        receipt['bytes'] = sum(component['bytes'] for component in receipt['components'])
        receipt['coverage'] = 'Offline extracted runtime files only; not a complete toolbox, transitive SBOM or clean-runtime acceptance.'
        (output/'runtime-stage.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf8')
        marker.unlink()
        return receipt
    except BaseException as error:
        marker.write_text(json.dumps({'status': 'failed', 'error': str(error)}), encoding='utf8')
        raise

if __name__ == '__main__':
    try:
        require(len(sys.argv) == 5, 'Usage: python stage-runtimes.py <inputs.json> <layout.json> <cache-directory> <new-output-directory>')
        result = stage_runtimes(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig')), json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig')), sys.argv[3], sys.argv[4])
        print(json.dumps({key: result[key] for key in ('status', 'files', 'bytes')}))
    except Exception as error:
        print(str(error), file=sys.stderr); sys.exit(1)
