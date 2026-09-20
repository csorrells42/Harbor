import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateInputs} from './acquire-inputs.mjs';
import {realDirectory,regular} from './build-node-projects.mjs';
const models=new Set(['Xenova/all-MiniLM-L6-v2','Xenova/all-MiniLM-L12-v2','Xenova/bge-small-en-v1.5','Xenova/bge-base-en-v1.5']);
const required=['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx','README.md'];
const demand=(ok,message)=>{if(!ok)throw Error(message);},sha=b=>createHash('sha256').update(b).digest('hex');
export function validateEmbeddingInputs(input){
 const plan=validateInputs(input),used=new Set(),seen=new Set(),files=[];
 demand(input.models?.length===models.size,'Exactly four reviewed embedding models required');
 for(const model of input.models){
  demand(models.has(model.id)&&!seen.has(model.id)&&/^[a-f0-9]{40}$/.test(model.revision??''),'Invalid or duplicate embedding model');seen.add(model.id);
  demand(Array.isArray(model.files)&&model.files.length>=required.length&&model.files.length<=8,'Invalid embedding file set');
  const names=new Set();
  for(const file of model.files){
   demand(typeof file.path==='string'&&(required.includes(file.path)||/^LICENSE(?:\.(?:txt|md))?$/i.test(file.path))&&!names.has(file.path.toLowerCase()),'Unsafe or duplicate model file');names.add(file.path.toLowerCase());
   const artifact=plan.artifacts.find(a=>a.id===file.artifact);demand(artifact&&!used.has(artifact.id),'Missing or reused model artifact');used.add(artifact.id);
   demand(artifact.version===model.revision&&artifact.url===`https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`&&artifact.bytes<=256*1024**2,'Artifact does not match pinned model revision/file');
   files.push({...artifact,path:`runtimes/embedding-models/${model.id}/${file.path}`});
  }
  demand(required.every(f=>names.has(f.toLowerCase())),'Missing required model files');
 }
 demand(used.size===plan.artifacts.length,'Unexpected unassigned model artifacts');
 return files;
}
export async function stageEmbeddingModels(inputFile,cacheRoot,outputRoot){
 const inputPath=path.resolve(inputFile),cache=path.resolve(cacheRoot),output=path.resolve(outputRoot);
 await regular(inputPath);await realDirectory(cache);await realDirectory(path.dirname(output));
 const bytes=await fs.readFile(inputPath),input=JSON.parse(bytes),files=validateEmbeddingInputs(input);
 for(const file of files){const source=path.join(cache,file.sha256+'.blob');demand((await regular(source)).size===file.bytes&&sha(await fs.readFile(source))===file.sha256,'Cached model identity differs');}
 await fs.mkdir(output);const marker=path.join(output,'EMBEDDING-STAGE-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const result={status:'in-progress',manifestSha256:sha(bytes),models:input.models.map(m=>({id:m.id,revision:m.revision,declaredLicense:m.declaredLicense})),files:[]};
 try{
  for(const file of files){const source=path.join(cache,file.sha256+'.blob');await regular(source);const data=await fs.readFile(source);demand(data.length===file.bytes&&sha(data)===file.sha256,'Model cache changed during stage');const target=path.join(output,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx'});demand(sha(await fs.readFile(target))===file.sha256,'Staged model readback differs');result.files.push({path:file.path,bytes:file.bytes,sha256:file.sha256});}
  result.status='complete';result.scope='Pinned model bytes and model cards staged offline; inference, complete license attribution and full release acceptance remain separate.';
  await fs.writeFile(path.join(output,'embedding-stage.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return result;
 }catch(e){await fs.writeFile(marker,JSON.stringify({...result,status:'failed',error:e.message},null,2));throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);demand(args.length===3,'Usage: stage-embedding-models.mjs <inputs> <cache> <new-output>');const result=await stageEmbeddingModels(...args);console.log(JSON.stringify({status:result.status,models:result.models.length,files:result.files.length}));}
