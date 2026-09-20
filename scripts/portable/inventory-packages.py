"""Inventory declared package licenses from the assembled, hashed payload.

No legal conclusions: preserve absent/conflicting metadata as review work.
Reads only assembly-listed files; never scans a runtime data/profile directory.
"""
import csv
import email.parser
import hashlib
import io
import json
import re
import sys
from pathlib import Path

def safe_relative(relative):
    if not isinstance(relative, str) or not relative or any(
        not part or part in ('.', '..') or re.search(r'[\\:\x00-\x1f<>"|?*]', part)
        or part.endswith(('.', ' ')) or re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part)
        for part in relative.split('/')
    ):
        raise ValueError('Unsafe assembly path')
    return relative


def distribution_parent(relative):
    # Include Python's bundled pip and its vendored distribution metadata too.
    match = re.match(r'^((?:packages/[^/]+/python|runtimes/python/Lib/site-packages)/(?:[^/]+/)*[^/]+\.dist-info)/', relative)
    return match[1] if match else None


def notice_name(name):
    return bool(re.match(r'(?i)(?:(?:third[-_ ]?party[-_ ]?)?(?:licenses?|licences?|copying|notices?))(?:\.|$|-)', name))


def checked_path(root, relative):
    safe_relative(relative)
    location = root
    for segment in relative.split('/'):
        location = location / segment
        if location.is_symlink() or getattr(location, 'is_junction', lambda: False)():
            raise ValueError('Assembly links are unsupported')
    if not location.resolve().is_relative_to(root):
        raise ValueError('Assembly path escaped root')
    return location


def inventory(root):
    root = Path(root).resolve()
    return _inventory(root)


def _inventory(root):
    # Main implementation is kept below to make path validation reusable in tests.
    assembly_bytes = checked_path(root, 'assembly.json').read_bytes()
    assembly = json.loads(assembly_bytes)
    if assembly.get('status') != 'complete':
        raise ValueError('Complete assembly required')
    listed = {}
    seen = set()
    for item in assembly['files']:
        relative = safe_relative(item['path'])
        if relative.casefold() in seen:
            raise ValueError('Duplicate assembly path')
        if type(item.get('bytes')) is not int or item['bytes'] < 0 or not re.fullmatch('[a-f0-9]{64}', item.get('sha256', '')):
            raise ValueError('Invalid assembly file identity')
        seen.add(relative.casefold())
        listed[relative] = item
    components = []
    direct_notices, python_notices = {}, {}
    for relative in listed:
        parent, _, name = relative.rpartition('/')
        if notice_name(name):
            direct_notices.setdefault(parent, []).append(relative)
        dist = distribution_parent(relative)
        if dist and (notice_name(name) or re.match(r'(?i)licen[cs]es?/.*', relative[len(dist)+1:])):
            python_notices.setdefault(dist, []).append(relative)

    def verified(relative):
        entry = listed[relative]
        data = checked_path(root, relative).read_bytes()
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Assembly file identity changed: ' + relative)
        return data

    for relative in sorted(listed):
        parent = relative.rsplit('/', 1)[0]
        if re.search(r'(?:^|/)node_modules/(?:@[^/]+/)?[^/]+/package\.json$', relative):
            package = json.loads(verified(relative))
            if not package.get('name') or not package.get('version'):
                continue
            components.append({'ecosystem': 'npm', 'name': package['name'], 'version': package['version'], 'metadata': relative,
                               'declaredLicense': package.get('license') or package.get('licenses') or 'NOASSERTION',
                               'noticeFiles': direct_notices.get(parent, [])})
        elif distribution_parent(relative) == parent and relative.endswith('/METADATA'):
            metadata = email.parser.BytesParser().parsebytes(verified(relative))
            if not metadata['Name'] or not metadata['Version']:
                raise ValueError('Incomplete Python distribution identity: ' + relative)
            notices = set(python_notices.get(parent, []))
            record = parent + '/RECORD'
            record_notices = []
            # Wheels can carry notices inside the import package rather than
            # dist-info. Attribute only paths claimed by this installed RECORD,
            # present in the assembly allowlist, and verified against that receipt.
            if record in listed:
                package_root = parent.rsplit('/', 1)[0]
                for row in csv.reader(io.StringIO(verified(record).decode('utf-8'))):
                    if not row or not notice_name(row[0].rsplit('/', 1)[-1]):
                        continue
                    try:
                        target = package_root + '/' + safe_relative(row[0])
                    except ValueError:
                        continue  # Never resolve traversal outside the installed package root.
                    if target in listed:
                        notices.add(target)
                        record_notices.append(target)
            components.append({'ecosystem': 'pypi', 'name': metadata['Name'], 'version': metadata['Version'], 'metadata': relative,
                               'declaredLicense': metadata.get('License-Expression') or metadata.get('License') or 'NOASSERTION',
                               'licenseClassifiers': [v for v in metadata.get_all('Classifier', []) if v.startswith('License ::')],
                               'noticeFiles': sorted(notices),
                               'recordNoticeAttribution': {'record': record, 'files': sorted(set(record_notices))} if record_notices else None})
    for component in components:
        # A notice's name alone is not verified content. Bind the actual carried text.
        component['noticeIdentities'] = [{'path': p, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                                        for p in component['noticeFiles'] for data in [verified(p)]]
    return {'schemaVersion': 1, 'assemblySha256': hashlib.sha256(assembly_bytes).hexdigest(), 'components': components,
            'componentLocations': len(components), 'uniqueNameVersions': len({(c['ecosystem'], c['name'], c['version']) for c in components}),
            'missingDeclarations': [c['metadata'] for c in components if c['declaredLicense'] in ('NOASSERTION', 'UNKNOWN')],
            'withoutRecognizedNoticeFile': [c['metadata'] for c in components if not c['noticeFiles']],
            'coverage': 'Assembly-listed npm and Python distribution metadata, including bundled runtime pip/npm and vendored Python distributions. Metadata and recognized notice bytes verified; notices outside Python dist-info are attributed only through its verified installed RECORD, with no traversal. Duplicate locations retained. Native binaries, model derivatives, source-only projects and dependencies inside app.asar need separate attribution. A declaration, RECORD attribution or carried notice is not a complete license review.'}


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: inventory-packages.py <assembled-root> <new-inventory.json>')
    root, output = map(lambda p: Path(p).resolve(), sys.argv[1:3])
    report = inventory(root)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, ensure_ascii=False)
    print(json.dumps({key: report[key] for key in ('componentLocations', 'uniqueNameVersions')}))
    print(json.dumps({'missingDeclarations': len(report['missingDeclarations']), 'withoutRecognizedNoticeFile': len(report['withoutRecognizedNoticeFile'])}))


if __name__ == '__main__':
    main()
