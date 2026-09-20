import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {validateEmbeddingInputs} from '../scripts/portable/stage-embedding-models.mjs';
const input=JSON.parse(await fs.readFile(new URL('../scripts/portable/embedding-inputs.windows-x64.json',import.meta.url),'utf8'));
test('reviewed model assets map to exact immutable repository paths',()=>{const files=validateEmbeddingInputs(input);assert.equal(files.length,input.artifacts.length);assert(files.every(f=>f.path.startsWith('runtimes/embedding-models/Xenova/')));});
test('model staging rejects traversal and duplicates',()=>{let copy=structuredClone(input);copy.models[0].files[0].path='../tokenizer.json';assert.throws(()=>validateEmbeddingInputs(copy),/Unsafe/);copy=structuredClone(input);copy.models[1]=copy.models[0];assert.throws(()=>validateEmbeddingInputs(copy),/duplicate/);});
test('model staging rejects mismatched source and unassigned assets',()=>{let copy=structuredClone(input);copy.artifacts[0].url=copy.artifacts[0].url.replace('/resolve/','/other/');assert.throws(()=>validateEmbeddingInputs(copy),/does not match/);copy=structuredClone(input);copy.artifacts.push({...copy.artifacts[0],id:'unassigned'});assert.throws(()=>validateEmbeddingInputs(copy),/unassigned/);});
