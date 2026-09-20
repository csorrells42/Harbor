import {createServer} from 'node:http';

// A deterministic protocol fixture, never evidence of model reasoning quality.
// It reads actual MCP results in the transcript; it cannot access fixture files.
export async function createWorkloadModelFixture(){
  const model='representative-workload-protocol-fixture',requests=[],errors=[];
  function objects(messages){
    const values=[];
    function visit(value,depth=0){if(depth>12)return;if(typeof value==='string'){try{visit(JSON.parse(value),depth+1);}catch{const start=value.indexOf('{'),end=value.lastIndexOf('}');if(start>=0&&end>=start)try{visit(JSON.parse(value.slice(start,end+1)),depth+1);}catch{}}}else if(value&&typeof value==='object'){values.push(value);for(const child of Object.values(value))visit(child,depth+1);}}
    for(const message of messages.filter(message=>message.role==='tool'))visit(message.content);return values;
  }
  const server=createServer(async(req,res)=>{
    let request;
    try{
      res.setHeader('Content-Type','application/json');
      if(req.method==='GET'){res.end(JSON.stringify({data:[{id:model}]}));return;}
      let raw='';for await(const chunk of req)raw+=chunk;request=JSON.parse(raw);
      if(!request.tools?.length){res.end(JSON.stringify({id:'probe',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));return;}
      const prompt=request.messages.find(message=>message.role==='user'&&typeof message.content==='string'&&message.content.includes('Representative workload'))?.content;
      const task=prompt?.match(/harbor-workloads-1; ([\w-]+)/)?.[1];if(!task)throw Error('Representative task identity missing');
      const step=request.messages.filter(message=>message.role==='assistant'&&message.tool_calls?.some(call=>call.id?.startsWith('fixture_'+task+'_'))).length;
      const data=objects(request.messages),brief=data.find(value=>value.project&&value.owner&&value.objectives),summary=data.find(value=>Array.isArray(value.rows)&&value.rows[0]?.totalCents!==undefined)?.rows[0];
      const records=data.filter(value=>value.project&&value.asOf),recovered=data.find(value=>value.reference&&value.value),page=data.find(value=>typeof value.content==='string'&&value.content.includes('Price cents'))?.content;
      const file=id=>['document-brief','dependent-report'].includes(id)?'output/result.md':id==='merge-csv'?'output/result.csv':id==='organize-files'?'output/':'output/result.json';
      const aggregate="SELECT sum(total_cents) AS totalCents,count(*) AS orderCount FROM orders WHERE region='West' AND status='paid'";
      let action;
      if(task==='document-brief')action=step===0?['fs_read',{path:'input/brief.json'}]:step===1?['document_render',{path:file(task),title:brief.project,sections:[{heading:'Project details',body:[brief.owner,brief.deadline,brief.budget,...brief.objectives].join('\n')}]}]:null;
      if(task==='merge-csv')action=step===0?['csv_merge',{sources:['input/part-a.csv','input/part-b.csv'],output:file(task),key:'id'}]:null;
      if(task==='convert-records')action=step===0?['csv_to_json',{source:'input/part-a.csv',output:file(task)}]:null;
      if(task==='organize-files')action=step<2?['fs_move',{source:'inbox/'+['meeting.txt','image-note.txt'][step],destination:'output/'+['meeting.txt','image-note.txt'][step]}]:null;
      if(task==='database-summary')action=step===0?['db_schema',{}]:step===1?['db_query',{sql:aggregate}]:step===2?['fs_write',{path:file(task),content:JSON.stringify({region:'West',...summary})}]:null;
      if(task==='dependent-report')action=step===0?['db_query',{sql:aggregate}]:step===1?['fs_read',{path:'input/brief.json'}]:step===2?['document_render',{path:file(task),title:brief.project,sections:[{heading:'Verified totals',body:brief.owner+'\nTotalCents: '+summary.totalCents+'\nOrderCount: '+summary.orderCount}]}]:null;
      if(task==='ambiguous-source')action=step<2?['fs_read',{path:step===0?'input/current.json':'input/archive.json'}]:step===2?['fs_write',{path:file(task),content:JSON.stringify(records.sort((a,b)=>b.asOf.localeCompare(a.asOf))[0])}]:null;
      if(task==='recover-read')action=step<2?['fs_read',{path:'input/fragile.json'}]:step===2?['fs_write',{path:file(task),content:JSON.stringify(recovered)}]:null;
      if(task==='browser-extract')action=step===0?['browser_open',{path:'/catalog'}]:step===1?['browser_click',{selector:'#product'}]:step===2?['browser_text',{selector:'main'}]:step===3?['fs_write',{path:file(task),content:JSON.stringify({sku:page.match(/A-[\w-]+/)[0],priceCents:Number(page.match(/Price cents\s+(\d+)/)[1]),availability:'In stock'})}]:null;
      const name=action&&request.tools.find(tool=>tool.function.name.endsWith('__'+action[0]))?.function.name;
      if(action&&!name)throw Error('Required fixture tool was not advertised: '+action[0]);
      const final=task==='missing-capability'?{status:'blocked',reason:'capability-unavailable'}:{status:'done',artifact:file(task)};
      const message=action?{role:'assistant',content:null,tool_calls:[{id:'fixture_'+task+'_'+step,type:'function',function:{name,arguments:JSON.stringify(action[1])}}]}:{role:'assistant',content:JSON.stringify(final)};
      requests.push({task,step,tool:action?.[0]??null,advertisedName:name??null,definitions:request.tools.length});
      if(request.stream){res.setHeader('Content-Type','text/event-stream');const delta=action?{role:'assistant',tool_calls:message.tool_calls.map((call,index)=>({...call,index}))}:message;res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
      else res.end(JSON.stringify({id:'fixture',object:'chat.completion',model,choices:[{index:0,message,finish_reason:action?'tool_calls':'stop'}]}));
    }catch(error){errors.push({message:error.message,toolMessages:request?.messages?.filter(message=>message.role==='tool')});res.statusCode=500;res.end(JSON.stringify({error:'Synthetic model protocol fixture failed'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {model,endpoint:`http://127.0.0.1:${server.address().port}/v1`,requests,errors,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
