// Developer acceptance harness. Run only while the candidate is closed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createMaintenance} from '../../src/core/maintenance.mjs';
const root=path.resolve(process.argv[3]||'.harbor-build/Harbor Portable'),id=process.argv[2];
const manager=await createMaintenance({root,isPaused:()=>true});
manager.start(id,{rebuild:true});
let previous='';const timer=setInterval(()=>{const s=manager.snapshot();const message=s.log.at(-1)||s.phase;if(message!==previous){console.log(message.slice(-1500));previous=message;}},5000);
try{
  const result=await manager.wait();await fs.writeFile(`evidence/portable/maintenance-${id}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({component:id,phase:result.phase,error:result.error,revision:result.revision}));
  if(!['complete','restart-required'].includes(result.phase))process.exitCode=1;
}finally{clearInterval(timer);await manager.close();}
