import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_inventory', Path(__file__).parents[1] / 'scripts/portable/inventory-packages.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='harbor-inventory-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = []

    def add(self, relative, text):
        data = text.encode()
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        self.files.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    def run_inventory(self):
        (self.root / 'assembly.json').write_text(json.dumps({'status': 'complete', 'files': self.files}))
        return module.inventory(self.root)

    def test_runtime_and_vendored_python_distributions_and_notice_bytes_are_observed(self):
        for folder in ['runtimes/python/Lib/site-packages/pip-1.dist-info',
                       'runtimes/python/Lib/site-packages/pip/_vendor/foo-2.dist-info',
                       'packages/tool/python/foo-2.dist-info']:
            self.add(folder + '/METADATA', 'Name: fixture\nVersion: 1\nLicense-Expression: MIT\n')
            self.add(folder + '/licenses/LICENSE.txt', 'fixture license bytes')
        self.add('data/private.dist-info/METADATA', 'PRIVATE DATA MUST NOT BE READ')
        report = self.run_inventory()
        self.assertEqual(report['componentLocations'], 3)
        self.assertEqual(report['uniqueNameVersions'], 1)
        self.assertEqual(report['withoutRecognizedNoticeFile'], [])
        self.assertTrue(all(c['noticeIdentities'][0]['sha256'] == hashlib.sha256(b'fixture license bytes').hexdigest() for c in report['components']))

    def test_npm_scopes_duplicates_unknown_declarations_and_tampered_notices(self):
        self.add('packages/group/node_modules/@scope/tool/package.json', '{"name":"@scope/tool","version":"1"}')
        self.add('packages/group/node_modules/@scope/tool/LICENSE', 'original')
        report = self.run_inventory()
        self.assertEqual(len(report['missingDeclarations']), 1)
        self.assertEqual(report['components'][0]['name'], '@scope/tool')
        (self.root / self.files[1]['path']).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.run_inventory()

    def test_paths_are_rejected_before_any_external_read(self):
        for path in ['../outside/package.json', '/absolute', 'C:/outside', 'x\\escape', 'x//y', 'x/./y', 'x/../y', 'x/file:stream', 'x/nul.txt', 'x/trailing.']:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'Unsafe'):
                module.safe_relative(path)
        self.add('packages/tool/node_modules/a/package.json', '{"name":"a","version":"1"}')
        self.files.append({**self.files[0], 'path': self.files[0]['path'].upper()})
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.run_inventory()

    def test_unlisted_files_and_profiles_never_enter_inventory(self):
        self.add('packages/tool/node_modules/a/package.json', '{"name":"a","version":"1","license":"MIT"}')
        self.add('packages/tool/node_modules/a/LICENSE', 'carried notice')
        self.files.pop()
        report = self.run_inventory()
        self.assertEqual(report['components'][0]['noticeFiles'], [])

    def test_record_attributes_carried_package_notices_but_never_unlisted_or_external_paths(self):
        dist = 'packages/tool/python/fixture-1.dist-info'
        self.add(dist + '/METADATA', 'Name: fixture\nVersion: 1\nLicense: MIT\n')
        self.add(dist + '/RECORD', 'fixture/LICENSE,,\nfixture/ThirdPartyNotices.txt,,\nfixture/unlisted/NOTICE,,\n../../../data/NOTICE,,\n')
        self.add('packages/tool/python/fixture/LICENSE', 'owned license')
        self.add('packages/tool/python/fixture/ThirdPartyNotices.txt', 'owned third party notice')
        self.add('packages/tool/python/unrelated/LICENSE', 'not owned')
        self.add('data/NOTICE', 'private')
        report = self.run_inventory()
        component = report['components'][0]
        self.assertEqual(component['noticeFiles'], ['packages/tool/python/fixture/LICENSE', 'packages/tool/python/fixture/ThirdPartyNotices.txt'])
        self.assertEqual(component['recordNoticeAttribution']['record'], dist + '/RECORD')
        (self.root / component['noticeFiles'][0]).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.run_inventory()

    def test_tampered_record_cannot_attribute_another_notice(self):
        dist = 'packages/tool/python/fixture-1.dist-info'
        self.add(dist + '/METADATA', 'Name: fixture\nVersion: 1\n')
        self.add(dist + '/RECORD', 'fixture/LICENSE,,\n')
        (self.root / (dist + '/RECORD')).write_text('unrelated/LICENSE,,\n')
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.run_inventory()


if __name__ == '__main__':
    unittest.main(verbosity=2)
