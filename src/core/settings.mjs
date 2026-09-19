import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {DELIVERY_MODES,LOCAL_MODELS,SEARCH_DEFAULTS} from './delivery-options.js';

export const DEFAULT_SETTINGS = Object.freeze({ port: 37373, networkEnabled: false, bindAddress: '0.0.0.0', mcpPath: '/mcp', requestTimeoutMs: 60000, toolTimeoutMs: 120000, allowedOrigins: Object.freeze([]), toolMode:'all',...SEARCH_DEFAULTS });

// Normalize only for comparison/URL formatting; retain the user's literal in settings.
export const urlHost = address => address.includes(':') ? new URL(`http://[${address}]`).hostname : address;

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a full object');
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, input[key]]));
  if(settings.toolMode===undefined)settings.toolMode='all';
  if(!DELIVERY_MODES.some(([mode])=>mode===settings.toolMode))throw new Error('toolMode is not a supported delivery mode');
  for(const [key,value] of Object.entries(SEARCH_DEFAULTS))if(settings[key]===undefined)settings[key]=structuredClone(value);
  const modes=DELIVERY_MODES.map(([mode])=>mode).filter(mode=>!['hybrid','all'].includes(mode));
  if(!Array.isArray(settings.hybridModes)||new Set(settings.hybridModes).size!==settings.hybridModes.length||settings.hybridModes.length<2||settings.hybridModes.some(mode=>!modes.includes(mode)))throw new Error('Hybrid requires at least two distinct methods and cannot include All tools');
  if(!Number.isInteger(settings.searchLimit)||settings.searchLimit<1||settings.searchLimit>50)throw new Error('Search result limit must be from 1 to 50');
  if(typeof settings.semanticMinScore!=='number'||!Number.isFinite(settings.semanticMinScore)||settings.semanticMinScore<0||settings.semanticMinScore>1)throw new Error('Semantic minimum score must be from 0 to 1');
  if(!LOCAL_MODELS.includes(settings.portkeyLocalModel))throw new Error('Select a supported local embedding model');
  for(const key of ['portkeyApiUrl','portkeyApiModel','portkeyApiKeyFile','portkeyWorkersUrl','portkeyWorkersModel','portkeyWorkersKeyFile'])if(typeof settings[key]!=='string')throw new Error(`${key} must be text`);
  for(const key of ['portkeyApiDimensions','portkeyWorkersDimensions'])if(!Number.isInteger(settings[key])||settings[key]<1||settings[key]>8192)throw new Error(`${key} must be from 1 to 8192`);
  for(const key of ['portkeyApiUrl','portkeyWorkersUrl'])if(settings[key]){let url;try{url=new URL(settings[key]);}catch{throw new Error(`${key} must be an HTTP(S) URL`);}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`${key} must be an HTTP(S) URL without credentials, query or fragment`);}
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('port must be an integer between 1 and 65535');
  if (typeof settings.networkEnabled !== 'boolean') throw new Error('networkEnabled must be boolean');
  const address = settings.bindAddress;
  if (typeof address !== 'string' || !isIP(address) || address.includes('%')) throw new Error('bindAddress must be a literal IP address or wildcard');
  // An inactive saved LAN address is a draft, not the loopback listener's bind.
  if (settings.networkEnabled) {
    const local = Object.values(networkInterfaces()).flat().filter(i => !i.address.includes('%')).map(i => urlHost(i.address));
    if (!(['0.0.0.0', '[::]', '[::1]'].includes(urlHost(address)) || /^127\./.test(address) || local.includes(urlHost(address)))) throw new Error('bindAddress must be a literal local IP address or wildcard');
  }
  try {
    const path = settings.mcpPath;
    const decoded = decodeURIComponent(path);
    const url = new URL(path, 'http://localhost');
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\s\x00-\x1f\x7f]/.test(path) || url.pathname !== path || /[?#\\\s\x00-\x1f\x7f]/.test(decoded) || /^\/api(?:\/|$)/i.test(decoded) || decoded.split('/').some(p => p === '.' || p === '..')) throw new Error();
  } catch { throw new Error('mcpPath must be a single URL path outside /api, without query or hash'); }
  for (const key of ['requestTimeoutMs', 'toolTimeoutMs']) if (!Number.isInteger(settings[key]) || settings[key] < 1000 || settings[key] > 3600000) throw new Error(`${key} must be an integer between 1000 and 3600000`);
  if (!Array.isArray(settings.allowedOrigins) || settings.allowedOrigins.some(origin => {
    try { const url = new URL(origin); return typeof origin !== 'string' || origin.includes('*') || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !!url.username || !!url.password; }
    catch { return true; }
  })) throw new Error('allowedOrigins must contain explicit HTTP(S) origins without credentials, paths or wildcards');
  return structuredClone(settings);
}

export async function loadSettings(path) {
  try {
    const saved=JSON.parse(await readFile(path,'utf8'));
    // Migrate only the previously supported All-tools Hybrid option; malformed
    // new settings are still rejected by validateSettings on save.
    if(Array.isArray(saved.hybridModes)&&saved.hybridModes.includes('all')){
      saved.hybridModes=[...new Set(saved.hybridModes.filter(mode=>mode!=='all'))];
      for(const fallback of SEARCH_DEFAULTS.hybridModes)if(saved.hybridModes.length<2&&!saved.hybridModes.includes(fallback))saved.hybridModes.push(fallback);
    }
    return validateSettings(saved);
  }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS); throw error; }
}

export async function persistSettings(path, settings) {
  settings = validateSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
