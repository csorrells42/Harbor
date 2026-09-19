import {deliveryComponents} from './delivery-components.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {dbhubRecipe} from './dbhub-component.mjs';
import {officeComponents,officeRecipe} from './office-components.mjs';
const source=process.cwd(),root=path.join(source,'.harbor-build/Harbor Portable');
const copy=async(a,b,filter)=>{await fs.mkdir(path.dirname(b),{recursive:true});await fs.cp(a,b,{recursive:true,...(filter?{filter}:{})});};
const sourceBundleItems=['src','assets','tests','package.json','package-lock.json','README.md','playwright.config.mjs','HARBOR-MANUAL.pdf','LICENSE','LICENSING.md','THIRD-PARTY-NOTICES.txt','docs','third-party','scripts/build-manual.py','scripts/requirements-manual.txt','scripts/build-visual-guides.py','scripts/requirements-visual-guides.txt'];
const portableDocuments=['HARBOR-MANUAL.pdf','LICENSE','LICENSING.md','THIRD-PARTY-NOTICES.txt','third-party'];
const sourceCopyExclusions=new Set(['node_modules','.git','.harbor-build','artifact','test-results','playwright-report','__pycache__','.pytest_cache','.venv','.cache','_build','.build','tmp','temp']);
const copySource=(a,b)=>copy(a,b,p=>{
  const relative=path.relative(source,p).split(path.sep).join('/');
  if(relative==='src/diagnostics/evidence'||relative.startsWith('src/diagnostics/evidence/'))return false;
  return !path.relative(a,p).split(path.sep).some(part=>sourceCopyExclusions.has(part))&&!/\.(?:py[co]|tmp|temp)$/i.test(p);
});
if(!process.argv.includes('--recipes-only')){
await copy(path.join(source,'release-portable-candidate/win-unpacked'),path.join(root,'application/initial'));
await fs.writeFile(path.join(root,'application/current.json'),JSON.stringify({path:'application/initial'}));
for(const file of ['launcher.mjs','probe.mjs','dbhub-component.mjs','build-dbhub.mjs','verify-dbhub.mjs','filesystem.mjs','github.mjs','verify-pdf-tools.mjs','office-components.mjs','verify-office-tools.mjs','delivery-components.mjs','build-delivery.mjs','verify-delivery-component.mjs','fastmcp-gateway.py','portkey-worker.mjs','prepare-embedding-models.mjs'])await copy(path.join(source,'scripts/portable',file),path.join(root,'support',file));
for(const file of ['update-github-release.mjs','stage-build-output.mjs'])await copy(path.join(source,'scripts/portable',file),path.join(root,'support',file));

await copy(path.join(source,'src/core/release-retention.mjs'),path.join(root,'support/release-retention.mjs'));
await copy(path.join(source,'src/core/portable.mjs'),path.join(root,'support/portable.mjs'));
await fs.writeFile(path.join(root,'Start Harbor.cmd'),'@echo off\r\n"%~dp0runtimes\\node\\node.exe" "%~dp0support\\launcher.mjs"\r\n');
await fs.writeFile(path.join(root,'Start Harbor.vbs'),'Set fso = CreateObject("Scripting.FileSystemObject")\r\nroot = fso.GetParentFolderName(WScript.ScriptFullName)\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & root & "\\runtimes\\node\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\support\\launcher.mjs" & Chr(34), 0, False\r\n');
const harborSource=path.join(root,'packages/harbor-source');
for(const item of sourceBundleItems)await copySource(path.join(source,item),path.join(harborSource,item));
await copySource(path.join(source,'scripts/portable'),path.join(harborSource,'scripts/portable'));
for(const item of portableDocuments)await copySource(path.join(source,item),path.join(root,item));
await fs.writeFile(path.join(harborSource,'.gitignore'),'node_modules/\nrelease*/\nartifact/\ntest-results/\nplaywright-report/\n.harbor-build/\n');
}
const t='${HARBOR_ROOT}',node=`${t}/runtimes/node/node.exe`,npm=`${t}/runtimes/node/node_modules/npm/bin/npm-cli.js`,uv=`${t}/runtimes/uv/uv.exe`,python=`${t}/runtimes/python/python.exe`;
const npmStep=args=>({command:node,args:[npm,...args]});
const probe=(id,group=id)=>({command:node,args:[`${t}/support/probe.mjs`,id,'${STAGE}',group]});
const components=[...officeComponents.map(officeRecipe),dbhubRecipe,...deliveryComponents];
for(const [id,name,packages] of [['general-local','Filesystem, Memory, Thinking and Desktop Commander',['@modelcontextprotocol/server-filesystem','@modelcontextprotocol/server-memory','@modelcontextprotocol/server-sequential-thinking','@wonderwhy-er/desktop-commander']],['browser-docs','Playwright and Context7',['@playwright/mcp','@upstash/context7-mcp']]]){
  components.push({id,name,path:`packages/${id}`,npmPackages:packages,build:[npmStep(['ci','--no-audit','--no-fund'])],verify:[probe(id)],notes:'Uses official published package releases. Current version is retained until discovery passes. Browser runtime updates require a matching bundled browser.'});
}
components.push({id:'typst-mcp',name:'Typst PDF Creator',path:'packages/typst-mcp',repository:'https://github.com/edward-lcl/typst-mcp.git',build:[npmStep(['ci','--no-audit','--no-fund']),npmStep(['run','build'])],verify:[npmStep(['test']),probe('typst-mcp')]});
components.push({id:'harbor',name:'Harbor Portable',path:'packages/harbor-source',selfUpdate:true,output:'artifact/win-unpacked',build:[npmStep(['ci','--no-audit','--no-fund']),npmStep(['run','pack','--','--win','--config.directories.output=artifact'])],verify:[npmStep(['test'])],notes:'Builds the bundled Harbor source. No upstream repository is configured for this user-created project. Activation occurs on the next Start Harbor launch.'});
components.push({id:'pdf-tools',name:'PDF Tools',path:'packages/pdf-tools',repository:'https://github.com/rsp2k/mcp-pdf.git',excludeFromStage:['python'],build:[{command:uv,args:['pip','install','--python',python,'--target','${STAGE}/python','${STAGE}[forms,markdown]','pypandoc_binary','fastmcp<3','mcp<2']}],verify:[probe('pdf-tools'),{command:node,args:[`${t}/support/verify-pdf-tools.mjs`,t,'${STAGE}']}],notes:'PDF assembly, extraction, forms and conversion. Markdown-to-PDF uses bundled Typst. OCR requires Tesseract; advanced Camelot/Tabula extraction is optional. Local compatibility fixes are committed and merged during updates.'});
components.push({id:'serena',name:'Serena',path:'packages/serena',repository:'https://github.com/oraios/serena.git',build:[{command:uv,args:['pip','install','--python',python,'--target','${STAGE}/python','${STAGE}']}],verify:[probe('serena')],notes:'Updates upstream while retaining committed local fixes. Language-specific server downloads can be needed for new programming languages.'});
components.push({id:'python-tools',name:'Fetch and Git Local',path:'packages/python-tools',excludeFromStage:['python'],update:[{command:uv,args:['pip','compile','--python',python,'--upgrade','requirements.in','--output-file','requirements.txt']}],build:[{command:uv,args:['pip','install','--python',python,'--target','${STAGE}/python','--requirements','requirements.txt']}],verify:[probe('fetch','python-tools'),probe('git-local','python-tools')],notes:'Updates published Fetch/Git Python packages and resolves a new dependency lock before activation.'});
components.push({id:'search',name:'Brave Search',path:'packages/search',npmPackages:['@brave/brave-search-mcp-server'],build:[npmStep(['ci','--no-audit','--no-fund'])],verify:[{command:node,args:['node_modules/@brave/brave-search-mcp-server/dist/index.js','--help']}],notes:'Build verifies the CLI. Search requires a Brave API key and live request verification.'});
components.push({id:'github',name:'GitHub',path:'packages/github',update:[{command:node,args:[`${t}/support/update-github-release.mjs`,'github/github-mcp-server','^github-mcp-server_Windows_x86_64\\.zip$','${STAGE}']}],verify:[{command:'${STAGE}/github-mcp-server.exe',args:['--version']},probe('github')],notes:'Downloads the official release, checks its published SHA256, then verifies the staged MCP server using the existing account.'});
await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,applicationBackups:0,components},null,2)+'\n');
console.log('Portable application and initial maintenance recipes staged');
