import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {listPackage,extractFile,statFile} from '@electron/asar';
assert.equal(process.argv.length,4,'Provide assembled candidate root and new output JSON');
const root=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]),hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=await fs.readFile(path.join(root,'assembly.json')),assembly=JSON.parse(bytes);
assert.equal(assembly.status,'complete');
const relative='application/initial/resources/app.asar',entry=assembly.files.find(f=>f.path===relative);
assert(entry);const archive=path.join(root,relative);assert.equal(hash(await fs.readFile(archive)),entry.sha256);
const paths=listPackage(archive).map(p=>p.replaceAll('\\','/').replace(/^\//,'')),components=[];
for(const file of paths.filter(p=>/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(p))){
 const native=path.normalize(file),info=statFile(archive,native,false);assert(!info.link&&!info.unpacked,'Metadata must be in the verified archive');
 const data=extractFile(archive,native,false),pkg=JSON.parse(data);assert(pkg.name&&pkg.version);
 const parent=file.slice(0,file.lastIndexOf('/'));
 const notices=paths.filter(p=>path.posix.dirname(p)===parent&&/^(license|licence|copying|notice)(\.|$|-)/i.test(path.posix.basename(p)));
 components.push({ecosystem:'npm',name:pkg.name,version:pkg.version,metadata:relative+'!/'+file,metadataSha256:hash(data),declaredLicense:pkg.license??pkg.licenses??'NOASSERTION',noticeFiles:notices.map(p=>relative+'!/'+p)});
}
const report={schemaVersion:1,assemblySha256:hash(bytes),archiveSha256:entry.sha256,components,scope:'Actual packaged production npm metadata inside the verified app.asar; native Electron/Chromium dependencies remain separate.'};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({packages:components.length,archiveSha256:entry.sha256}));
