import path from 'node:path';
import {readFile, mkdir, writeFile, access} from 'node:fs/promises';

export function resolvePortableConfig(config, root) {
  if (!root) return structuredClone(config);
  const expand = value => typeof value === 'string' ? value.replaceAll('${HARBOR_ROOT}', root.replaceAll('\\','/')) : value;
  const walk = value => Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)])) : expand(value);
  return walk(config);
}

export function portableEnvironment(root, env) {
  if(!root)return env;
  const bins=['runtimes/node','runtimes/node/node_modules/.bin','runtimes/git/cmd','runtimes/git/usr/bin','runtimes/python','runtimes/typst','runtimes/uv'];
  const system=env.SystemRoot||env.SYSTEMROOT||'C:/Windows';
  // Windows environment keys are case-insensitive; do not leave an inherited Path
  // competing with the explicitly bundled PATH passed to child_process.
  env=Object.fromEntries(Object.entries(env).filter(([key])=>!['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','JAVA_HOME','JAVA_TOOL_OPTIONS','GRADLE_USER_HOME','PYTHONPATH','PYTHONHOME','NODE_PATH'].includes(key.toUpperCase())));
  return {...env,PATH:[...bins.map(p=>path.join(root,p)),path.join(system,'System32'),system,path.join(system,'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
    HOME:path.join(root,'data/home'),USERPROFILE:path.join(root,'data/home'),APPDATA:path.join(root,'data/home/AppData/Roaming'),LOCALAPPDATA:path.join(root,'data/home/AppData/Local'),
    TEMP:path.join(root,'data/temp'),TMP:path.join(root,'data/temp'),UV_CACHE_DIR:path.join(root,'data/cache/uv'),npm_config_cache:path.join(root,'data/cache/npm'),
    PNPM_HOME:path.join(root,'data/home/pnpm'),PNPM_CONFIG_STORE_DIR:path.join(root,'data/cache/pnpm'),PNPM_CONFIG_NODE_LINKER:'hoisted',PNPM_CONFIG_PACKAGE_IMPORT_METHOD:'copy',
    PLAYWRIGHT_BROWSERS_PATH:path.join(root,'runtimes/browsers'),PYTHONNOUSERSITE:'1',PYTHONUTF8:'1'};
}

export async function initializePortable(root) {
  root=path.resolve(root);
  const marker=JSON.parse(await readFile(path.join(root,'portable.json'),'utf8'));
  if(marker.version!==1)throw new Error('Unsupported Harbor Portable folder format');
  for(const dir of ['data','data/logs','data/temp','data/home','data/workspace','data/maintenance'])await mkdir(path.join(root,dir),{recursive:true});
  const target=path.join(root,'data/servers.json');
  try{await access(target);}catch(error){
    if(error.code!=='ENOENT')throw error;
    const seed=await readFile(path.join(root,'catalog.json'),'utf8');
    await writeFile(target,seed,{flag:'wx'});
  }
  return {root,data:path.join(root,'data'),node:path.join(root,'runtimes/node/node.exe')};
}
