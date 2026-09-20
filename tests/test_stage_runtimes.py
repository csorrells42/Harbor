import hashlib, importlib.util, io, json, pathlib, stat, tarfile, tempfile, unittest, zipfile
module_path=pathlib.Path(__file__).resolve().parents[1]/'scripts/portable/stage-runtimes.py'
spec=importlib.util.spec_from_file_location('stage_runtimes',module_path)
stager=importlib.util.module_from_spec(spec);spec.loader.exec_module(stager)
class RuntimeStageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='harbor-stage-');self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name);self.cache=self.root/'cache';self.cache.mkdir()
    def fixture(self, names=None, tar=False, link=False):
        memory=io.BytesIO()
        if tar:
            with tarfile.open(fileobj=memory,mode='w:gz') as archive:
                item=tarfile.TarInfo('vendor/python.exe');item.size=3
                if link:item.type=tarfile.SYMTYPE;item.linkname='../../outside';item.size=0
                archive.addfile(item,io.BytesIO(b'abc') if not link else None)
        else:
            with zipfile.ZipFile(memory,'w') as archive:
                for name in names or ['vendor/bin/runtime.exe','vendor/LICENSE']:
                    if link:
                        item=zipfile.ZipInfo(name);item.create_system=3;item.external_attr=(stat.S_IFLNK|0o777)<<16;archive.writestr(item,'../../outside')
                    else:archive.writestr(name,b'abc')
        payload=memory.getvalue();sha=hashlib.sha256(payload).hexdigest();(self.cache/(sha+'.blob')).write_bytes(payload)
        inputs={'schemaVersion':1,'release':'fixture','artifacts':[{'id':'runtime','bytes':len(payload),'sha256':sha,'version':'1','usage':'both','license':'MIT'}]}
        layout={'schemaVersion':1,'components':[{'artifact':'runtime','target':'runtimes/example','format':'tar.gz' if tar else 'zip','stripPrefix':'vendor','maxUnpackedBytes':100,'relocate':{'bin/runtime.exe':'runtime.exe'}}]}
        return inputs,layout
    def test_zip_staging_and_unicode_relocation_keep_hashes_and_refuse_overwrite(self):
        inputs,layout=self.fixture();output=self.root/'Staged ü space';result=stager.stage_runtimes(inputs,layout,self.cache,output)
        self.assertEqual(result['status'],'complete');self.assertEqual(result['files'],2)
        self.assertEqual((output/'runtimes/example/runtime.exe').read_bytes(),b'abc');self.assertFalse((output/'STAGING-INCOMPLETE.json').exists())
        relocated=self.root/'別 folder';output.rename(relocated)
        for component in result['components']:
            for item in component['files']:self.assertEqual(stager.digest(relocated/item['path']),item['sha256'])
        with self.assertRaisesRegex(ValueError,'new directory'):stager.stage_runtimes(inputs,layout,self.cache,relocated)
    def test_tar_supported_without_extractall(self):
        inputs,layout=self.fixture(tar=True);result=stager.stage_runtimes(inputs,layout,self.cache,self.root/'out');self.assertEqual(result['files'],1)
    def test_nested_browser_target_preserves_files(self):
        inputs,layout=self.fixture(['vendor/chrome-win64/chrome.exe','vendor/chrome-win64/resources.pak'])
        layout['components'][0]['target']='runtimes/browsers/chromium-1246'
        result=stager.stage_runtimes(inputs,layout,self.cache,self.root/'Browser stage ü')
        self.assertEqual(result['files'],2)
        self.assertEqual((self.root/'Browser stage ü/runtimes/browsers/chromium-1246/chrome-win64/chrome.exe').read_bytes(),b'abc')
    def test_overlapping_targets_rejected_before_output_in_either_order(self):
        for index,targets in enumerate([('runtimes/browsers','runtimes/browsers/chromium-1246'),('runtimes/browsers/chromium-1246','runtimes/browsers'),('runtimes/example','runtimes/example')]):
            with self.subTest(targets=targets):
                inputs,layout=self.fixture();inputs['artifacts'].append({**inputs['artifacts'][0],'id':'second'})
                layout['components'][0]['target']=targets[0]
                layout['components'].append({**layout['components'][0],'artifact':'second','target':targets[1]})
                out=self.root/('overlap'+str(index))
                with self.assertRaisesRegex(ValueError,'overlap'):stager.stage_runtimes(inputs,layout,self.cache,out)
                self.assertFalse(out.exists())
    def test_nested_targets_only_allowed_under_browser_directory(self):
        for target in ('runtimes/node/subdir','runtimes/browsers/chromium-1246/child','runtimes/browsers/../escape'):
            inputs,layout=self.fixture();layout['components'][0]['target']=target
            with self.subTest(target=target),self.assertRaises(ValueError):stager.validated_plans(inputs,layout)
    def test_bad_archive_paths_and_collisions_never_finish(self):
        for index,names in enumerate([['vendor/../escape'],['vendor/C:/escape'],['vendor/NUL.txt'],['vendor/a.'],['vendor/A','vendor/a'],['vendor/Folder/a','vendor/folder/b'],['outside/file']]):
            with self.subTest(names=names):
                inputs,layout=self.fixture(names);out=self.root/('bad'+str(index))
                with self.assertRaises(ValueError):stager.stage_runtimes(inputs,layout,self.cache,out)
                self.assertFalse((out/'runtime-stage.json').exists());self.assertEqual(json.loads((out/'STAGING-INCOMPLETE.json').read_text())['status'],'failed')
        self.assertFalse((self.root/'escape').exists())
    def test_archive_links_rejected(self):
        for tar in (False,True):
            inputs,layout=self.fixture(tar=tar,link=True)
            with self.assertRaisesRegex(ValueError,'links'):stager.stage_runtimes(inputs,layout,self.cache,self.root/str(tar))
    def test_missing_or_corrupt_input_creates_no_output(self):
        inputs,layout=self.fixture();archive=self.cache/(inputs['artifacts'][0]['sha256']+'.blob');archive.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'checksum'):stager.stage_runtimes(inputs,layout,self.cache,self.root/'out')
        self.assertFalse((self.root/'out').exists())
    def test_size_limit_retains_failed_marker(self):
        inputs,layout=self.fixture();layout['components'][0]['maxUnpackedBytes']=2
        with self.assertRaisesRegex(ValueError,'expansion'):stager.stage_runtimes(inputs,layout,self.cache,self.root/'out')
        self.assertTrue((self.root/'out/STAGING-INCOMPLETE.json').exists())
    def test_layout_must_account_for_every_input(self):
        inputs,layout=self.fixture();inputs['artifacts'].append({**inputs['artifacts'][0],'id':'omitted'})
        with self.assertRaisesRegex(ValueError,'every declared'):stager.stage_runtimes(inputs,layout,self.cache,self.root/'out')
        self.assertFalse((self.root/'out').exists())
if __name__=='__main__':unittest.main()

