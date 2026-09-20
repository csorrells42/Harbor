import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateConfig} from '../../src/core/config.mjs';
import {officeComponents,officeServer} from './office-components.mjs';
import {dbhubServer} from './dbhub-component.mjs';

const root='${HARBOR_ROOT}',node=`${root}/runtimes/node/node.exe`,python=`${root}/runtimes/python/python.exe`;
const workspace=`${root}/data/workspace`;
const npmEntry=(group,entry)=>`${root}/packages/${group}/node_modules/${entry}`;
const native=(id,name,command,args,env={},autoStart=false)=>({id,name,transport:'stdio',runtime:'native',command,args,cwd:workspace,env,autoStart,autoRestart:true,enabled:true,onDemand:false,idleMinutes:5});
const pythonEnv=group=>({PYTHONPATH:`${root}/support/python-site;${root}/packages/${group}/python`});

// Declarative release input. Never read a user's servers.json, account files or
// developer environment when constructing a distribution's initial catalog.
export function createSeedCatalog(){
 const servers=[
  native('serena','Serena',python,['-c','from serena.cli import top_level; top_level()','start-mcp-server','--transport','stdio','--enable-web-dashboard','False','--open-web-dashboard','False','--enable-gui-log-window','False'],{...pythonEnv('serena'),SERENA_HOME:`${root}/data/serena`}),
  native('context7','Context7',node,[npmEntry('browser-docs','@upstash/context7-mcp/dist/index.js'),'--transport','stdio']),
  native('playwright','Playwright',node,[npmEntry('browser-docs','@playwright/mcp/cli.js'),'--headless','--browser','chromium','--executable-path',`${root}/runtimes/browsers/chromium-1246/chrome-win64/chrome.exe`,'--isolated','--allow-unrestricted-file-access']),
  native('github','GitHub',node,[`${root}/support/github.mjs`]),
  native('filesystem','Filesystem',node,[`${root}/support/filesystem.mjs`],{},true),
  native('memory','Memory',node,[npmEntry('general-local','@modelcontextprotocol/server-memory/dist/index.js')],{MEMORY_FILE_PATH:`${root}/data/memory/memory.jsonl`}),
  native('sequential-thinking','Sequential Thinking',node,[npmEntry('general-local','@modelcontextprotocol/server-sequential-thinking/dist/index.js')],{DISABLE_THOUGHT_LOGGING:'true'}),
  native('desktop-commander','Desktop Commander',node,[npmEntry('general-local','@wonderwhy-er/desktop-commander/dist/index.js'),'--no-onboarding'],{HOME:`${root}/data/home`,USERPROFILE:`${root}/data/home`,DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1',HARBOR_BUNDLED_CHROMIUM:`${root}/runtimes/browsers/chromium-1246/chrome-win64/chrome.exe`},true),
  native('fetch','Fetch',python,['-m','mcp_server_fetch'],pythonEnv('python-tools')),
  // The CLI accepts an omitted repository. Each tool invocation can select a
  // real repository; a clean distribution does not invent a user's checkout.
  native('git-local','Git Local',python,['-m','mcp_server_git'],{...pythonEnv('python-tools'),GIT_PYTHON_GIT_EXECUTABLE:`${root}/runtimes/git/cmd/git.exe`}),
  {id:'exa',name:'Exa',transport:'http',runtime:'native',url:'https://mcp.exa.ai/mcp',autoStart:false,autoRestart:true,enabled:true,onDemand:false,idleMinutes:5},
  native('brave-search','Brave Search',node,[npmEntry('search','@brave/brave-search-mcp-server/dist/index.js'),'--transport','stdio'],{BRAVE_API_KEY_FILE:`${root}/data/auth/brave-api-key.txt`}),
  native('typst-mcp','Typst PDF Creator',node,[`${root}/packages/typst-mcp/dist/index.js`],{},true),
  native('pdf-tools','PDF Tools',python,['-m','mcp_pdf.server'],{...pythonEnv('pdf-tools'),PDF_TEMP_DIR:`${root}/data/temp/pdf-tools`,FASTMCP_CHECK_FOR_UPDATES:'off'},true),
  ...officeComponents.map(officeServer),
  structuredClone(dbhubServer)
 ].map(validateConfig);
 if(servers.length!==19||new Set(servers.map(server=>server.id)).size!==19)throw Error('Unexpected release catalog membership');
 return {version:1,servers};
}

export async function writeSeedCatalog(destination){
 const catalog=createSeedCatalog();
 // Initialization and later assembly must not overwrite personal choices.
 await writeFile(destination,JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
 return catalog;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==3)throw Error('Usage: node seed-catalog.mjs <new-catalog.json>');
 const result=await writeSeedCatalog(process.argv[2]);console.log(JSON.stringify({servers:result.servers.length,scope:'Clean release catalog only; package availability and runtime acceptance are separate checks.'}));
}
