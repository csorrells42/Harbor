"""Emit a schema-validated observed inventory, with incomplete coverage explicit.

Inputs are immutable assembly, package inventories and the pinned stage plan.
This does not infer dependency edges or grant missing redistribution rights.
"""
import datetime
import hashlib
import json
import re
import sys
import uuid
from pathlib import Path
from urllib.parse import quote
import jsonschema
from referencing import Registry, Resource

if len(sys.argv) not in (7, 8):
    raise SystemExit('Usage: build-sbom.py <root> <plan> <packages> <application> <schemas> <new-output> [native-notice-inventory]')
root, plan_path, package_path, app_path, schema_root, output = map(lambda p: Path(p).resolve(), sys.argv[1:7])
native_path = Path(sys.argv[7]).resolve() if len(sys.argv) == 8 else None
digest = lambda value: hashlib.sha256(value).hexdigest()
read = lambda p: json.loads(p.read_bytes())
assembly_bytes = (root / 'assembly.json').read_bytes()
assembly, plan = json.loads(assembly_bytes), read(plan_path)
assert assembly['status'] == 'complete'
assert assembly['planSha256'] == digest(plan_path.read_bytes())
assert not output.exists()
for entry in plan['stages'].values():
    receipt_bytes = (plan_path.parent / entry['root'] / entry['receipt']).read_bytes()
    assert digest(receipt_bytes) == entry['receiptSha256']
    assert json.loads(receipt_bytes)['status'] == 'complete'
listed = {f['path']: f for f in assembly['files']}
components = []
prop = lambda name, value: {'name': 'harbor:' + name, 'value': value if isinstance(value, str) else json.dumps(value, sort_keys=True)}
ref = lambda value: 'component-' + digest(value.encode())[:24]

for inventory_path in (package_path, app_path):
    inventory = read(inventory_path)
    assert inventory['assemblySha256'] == digest(assembly_bytes)
    for item in inventory['components']:
        metadata = item['metadata']
        metadata_hash = item.get('metadataSha256') or listed[metadata]['sha256']
        name = item['name'] if item['ecosystem'] == 'npm' else re.sub(r'[-_.]+', '-', item['name']).lower()
        component = {'type': 'library', 'bom-ref': ref(metadata), 'name': item['name'], 'version': item['version'],
                     'purl': 'pkg:' + item['ecosystem'] + '/' + quote(name, safe='/.-_') + '@' + quote(item['version'], safe='.-_'),
                     'properties': [prop('metadata-path', metadata), prop('metadata-sha256', metadata_hash),
                                    prop('declared-license', item['declaredLicense']), prop('notice-paths', item['noticeFiles'])]}
        if item['name'] == 'proxy-tools':
            component['properties'].append(prop('license-review', 'NOASSERTION: metadata says MIT; source header says BSD; separate license text missing.'))
        components.append(component)

if native_path is not None:
    native_inventory = read(native_path)
    assert native_inventory['assemblySha256'] == digest(assembly_bytes)
    assert isinstance(native_inventory['components'], list)
    components.extend(native_inventory['components'])

for kind in ('runtime', 'browser', 'models', 'binaries'):
    entry = plan['stages'][kind]
    stage = plan_path.parent / entry['root']
    receipt_bytes = (stage / entry['receipt']).read_bytes()
    assert digest(receipt_bytes) == entry['receiptSha256']
    receipt = json.loads(receipt_bytes)
    # Pin declared public inputs to the exact source snapshot used for this app.
    app_stage = plan_path.parent / plan['stages']['application']['root']
    names = {'runtime': 'runtime-inputs', 'browser': 'browser-inputs', 'models': 'embedding-inputs', 'binaries': 'application-binary-inputs'}
    manifest_relative = 'scripts/portable/' + names[kind] + '.windows-x64.json'
    app_receipt = read(app_stage / plan['stages']['application']['receipt'])
    manifest_path = app_stage / 'source' / manifest_relative
    manifest_seal = next(f for f in app_receipt['sourceFiles'] if f['path'] == manifest_relative)
    assert digest(manifest_path.read_bytes()) == manifest_seal['sha256']
    for artifact in read(manifest_path)['artifacts']:
        components.append({'type': 'file' if kind == 'models' else 'application',
                           'bom-ref': ref(kind + '/' + artifact['id']), 'name': artifact['id'], 'version': artifact['version'],
                           'description': 'Pinned input artifact; native transitive dependency enumeration is incomplete.',
                           'externalReferences': [{'type': 'distribution', 'url': artifact['url'],
                                                   'hashes': [{'alg': 'SHA-256', 'content': artifact['sha256']}]}],
                           'properties': [prop('declared-license', artifact['license']), prop('stage-receipt-sha256', entry['receiptSha256']),
                                          prop('usage', artifact['usage'])]})

source_entry = plan['stages']['source']
source_bytes = (plan_path.parent / source_entry['root'] / source_entry['receipt']).read_bytes()
assert digest(source_bytes) == source_entry['receiptSha256']
for source in json.loads(source_bytes)['components']:
    components.append({'type': 'application', 'bom-ref': ref('source/' + source['id']), 'name': source['id'],
                       'version': source['tree'], 'externalReferences': [{'type': 'vcs', 'url': source['repository']}],
                       'properties': [prop('source-git-tree', source['tree']), prop('source-location', 'packages/' + source['id']),
                                      prop('license-review', 'See retained source and exact notices; no inferred license grant.')]})

app_archive = listed['application/initial/resources/app.asar']
components.append({'type': 'file', 'bom-ref': ref(app_archive['path']), 'name': 'Harbor app.asar',
                   'hashes': [{'alg': 'SHA-256', 'content': app_archive['sha256']}],
                   'properties': [prop('path', app_archive['path'])]})
limitations = ['Native bundled transitive components are not fully enumerated.',
               'Missing/conflicting license metadata and corresponding-source obligations remain unresolved.',
               'No dependency edges are asserted from a flat installed inventory.',
               'No claim of public redistribution clearance, independent clean-machine acceptance or vulnerability absence.']
assert len({component['bom-ref'] for component in components}) == len(components), 'Duplicate component identity'
bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'serialNumber': 'urn:uuid:' + str(uuid.uuid4()), 'version': 1,
       'metadata': {'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
                    'component': {'type': 'application', 'bom-ref': 'harbor-portable', 'name': 'Harbor Portable', 'version': assembly['release']},
                    'properties': [prop('assembly-sha256', digest(assembly_bytes)), prop('plan-sha256', assembly['planSha256']),
                                   prop('coverage-limitations', limitations), prop('package-inventory-sha256', digest(package_path.read_bytes())),
                                   prop('application-inventory-sha256', digest(app_path.read_bytes())),
                                   prop('native-notice-inventory-sha256', digest(native_path.read_bytes()) if native_path else 'not provided'),
                                   prop('generator-sha256', digest(Path(__file__).read_bytes()))]},
       'components': components, 'compositions': [{'aggregate': 'incomplete', 'assemblies': ['harbor-portable']}]}
assert len({c['bom-ref'] for c in components}) == len(components)
registry = Registry()
for name in ('bom-1.6.schema.json', 'spdx.schema.json', 'jsf-0.82.schema.json'):
    schema = read(schema_root / name)
    registry = registry.with_resource('http://cyclonedx.org/schema/' + name, Resource.from_contents(schema))
    if schema.get('$id'):
        registry = registry.with_resource(schema['$id'], Resource.from_contents(schema))
jsonschema.Draft7Validator(read(schema_root / 'bom-1.6.schema.json'), registry=registry).validate(bom)
with output.open('x', encoding='utf-8') as stream:
    json.dump(bom, stream, ensure_ascii=False, indent=2)
print(json.dumps({'components': len(components), 'schemaValidation': 'passed', 'composition': 'incomplete', 'sha256': digest(output.read_bytes())}))
