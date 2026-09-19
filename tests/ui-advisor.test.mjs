import test from 'node:test';
import assert from 'node:assert/strict';
import {advise} from '../src/ui/advisor-rules.js';
const server=(id,extra={})=>({id,name:id,status:'stopped',toolCount:0,...extra});
test('catalog explains the whole toolbox and excludes internet-dependent suggestions offline without claiming a sandbox',()=>{
  const expected={research:['exa','fetch','duckdb'],coding:['serena','context7','git-local'],files:['typst-mcp','pdf-tools','filesystem','markitdown','excel','word'],browser:['playwright'],debugging:['serena'],planning:['sequential-thinking','memory'],offline:['filesystem','git-local']};
  const ids=['serena','typst-mcp','pdf-tools','duckdb','dbhub','markitdown','excel','word','context7','github','playwright','exa','brave-search','desktop-commander','fetch','git-local','memory','filesystem','sequential-thinking'];
  for(const [category,recommended] of Object.entries(expected)){
    const entries=advise(ids.map(id=>server(id)),{category});
    for(const id of recommended)assert.equal(entries.find(e=>e.server.id===id).tier,'recommended',`${category}: ${id}`);
    for(const entry of entries)assert.doesNotMatch(entry.reason,/No local recommendation/);
  }
  const local=advise(ids.map(id=>server(id)),{category:'research',internet:false});
  for(const id of ['exa','fetch','github','context7']){const entry=local.find(e=>e.server.id===id);assert.equal(entry.tier,'not-needed');assert.equal(entry.selectable,false);assert.match(entry.reason,/Internet unavailable/);}
  const warnings=advise(ids.map(id=>server(id))).flatMap(e=>e.warnings??[]).join(' ');
  for(const pattern of [/host shell.*not.*sandbox/i,/write tools/i,/no secrets/i,/verify fetched content/i,/BRAVE_API_KEY_FILE/])assert.match(warnings,pattern);
});

test('unknown custom IDs remain visible without inferred capabilities or name matching',()=>{
  for(const id of ['my-serena','constructor','toString','__proto__']){
    const [entry]=advise([server(id,{name:'Serena'})],{category:'coding',internet:false});
    assert.equal(entry.tier,'optional');assert.match(entry.reason,/No local recommendation rule/);assert.equal(entry.internet,'unknown');assert.equal(entry.selectable,true);
  }
});

test('overlap recommendations account for selected and running alternatives, never duplicate automatic suggestions',()=>{
  for(const extra of [{status:'running'},{}]){
    const entries=advise([server('filesystem'),server('desktop-commander',extra),server('exa'),server('brave-search',{status:'running'})],{category:'files',selected:new Set(['desktop-commander'])});
    assert.equal(entries[0].tier,'optional');assert.match(entries[0].reason,/desktop-commander.*(selected|running)/);assert.match(entries[1].warnings.join(' '),/Overlap/);
  }
  const research=advise([server('exa'),server('brave-search',{status:'running'})],{category:'research'});
  assert.equal(research[0].tier,'optional');assert.match(research[0].reason,/brave-search.*running/);
});

test('known missing prerequisites block even manually selected entries; only observed running overrides',()=>{
  const ids=['brave-search'];
  const blocked=advise(ids.map(id=>server(id,{env:{API_KEY:'present-is-not-proof'}})),{category:'debugging',selected:new Set(ids)});
  for(const entry of blocked){assert.equal(entry.tier,'needs-setup');assert.equal(entry.selectable,false);assert.match(entry.reason,/Configure.*start individually/i);}
  for(const entry of advise(ids.map(id=>server(id,{status:'running'})),{category:'debugging'}))assert.equal(entry.selectable,true);
});
