import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]),pkg=path.join(root,'packages/portkey-tools');
const {env,pipeline}=await import(pathToFileURL(path.join(pkg,'node_modules/@xenova/transformers/src/transformers.js')));
env.cacheDir=path.join(root,'runtimes/embedding-models');
for(const model of ['Xenova/all-MiniLM-L6-v2','Xenova/all-MiniLM-L12-v2','Xenova/bge-small-en-v1.5','Xenova/bge-base-en-v1.5']){
  console.log(`Preparing ${model}`);const extractor=await pipeline('feature-extraction',model,{quantized:true});
  const output=await extractor('Find tools for merging PDF documents',{pooling:'mean',normalize:true});console.log(JSON.stringify({model,dimensions:output.data.length}));await extractor.dispose();
}
