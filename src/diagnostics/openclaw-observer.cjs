// Loaded only by a fresh diagnostic OpenClaw home. Never installed in the user's agent.
const {appendFileSync}=require('node:fs');
module.exports={id:'harbor-observer',name:'Harbor trial observer',register(api){
  const cfg=api.pluginConfig;let bytes=0,limited=false;
  const emit=value=>{if(limited)return;const line=JSON.stringify({...value,ms:Date.now()-cfg.startedAt})+'\n';bytes+=Buffer.byteLength(line);if(bytes>4*1024*1024){limited=true;appendFileSync(cfg.file,'{"type":"observation-limit"}\n');return;}appendFileSync(cfg.file,line);};
  api.on('before_tool_call',event=>{emit({type:'tool-start',name:event.toolName,callId:event.toolCallId??null,args:event.params});});
  api.on('after_tool_call',event=>{emit({type:'tool-end',name:event.toolName,callId:event.toolCallId??null,failed:!!event.error,durationMs:event.durationMs??null});});
}};
