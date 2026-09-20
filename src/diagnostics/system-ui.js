import {createTemperatureChart} from './temperature-ui.js';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const gib=bytes=>Number.isFinite(bytes)?`${(bytes/2**30).toFixed(1)} GiB`:'Unknown';
const capacity=bytes=>Number.isFinite(bytes)?bytes>=2**40?`${(bytes/2**40).toFixed(2)} TiB`:gib(bytes):'Unknown';
const number=value=>value===null||value===undefined?null:Number(value);
const svg=(tag,attrs)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);return n;};
function gauge(title){
  const card=el('div','','diag-gauge-card');card.append(el('h3',title));
  const graphic=svg('svg',{viewBox:'0 0 140 112',role:'meter','aria-label':title,'aria-valuemin':'0','aria-valuemax':'100'});
  const arc='M 33.23 91.77 A 52 52 0 1 1 106.77 91.77';
  graphic.append(svg('path',{d:arc,class:'diag-gauge-track',pathLength:'100'}));
  const fill=svg('path',{d:arc,class:'diag-gauge-fill',pathLength:'100','stroke-dasharray':'0 100'}),value=svg('text',{x:'70',y:'65',class:'diag-gauge-value','text-anchor':'middle'});
  const unit=svg('text',{x:'70',y:'84',class:'diag-gauge-unit','text-anchor':'middle'});unit.textContent='utilization';graphic.append(fill,value,unit);
  const detail=el('p','','diag-gauge-detail');card.append(graphic,detail);
  return {card,set(percent,text,unitText='utilization'){
    const valid=Number.isFinite(percent),p=valid?Math.max(0,Math.min(100,percent)):0;fill.setAttribute('stroke-dasharray',`${p} 100`);value.textContent=valid?`${p.toFixed(0)}%`:'—';unit.textContent=valid?unitText:'unavailable';detail.textContent=text;
    if(valid){graphic.setAttribute('aria-valuenow',p.toFixed(1));graphic.setAttribute('aria-valuetext',`${p.toFixed(1)} percent · ${text}`);}else{graphic.removeAttribute('aria-valuenow');graphic.setAttribute('aria-valuetext',text);}
    card.dataset.level=!valid?'unknown':p>=90?'high':p>=70?'medium':'normal';
  }};
}
export function createSystemOverview(){
  let selectedGpu='';
  const element=el('section','','diag-system');element.setAttribute('aria-label','Live system overview');
  const header=el('div','','diag-system-heading'),heading=el('h2','System overview'),freshness=el('span','Reading hardware…','muted');header.append(heading,freshness);
  const grid=el('div','','diag-gauge-grid'),cpu=gauge('CPU'),gpu=gauge('GPU'),memory=gauge('System memory'),vram=gauge('GPU memory');grid.append(cpu.card,gpu.card,memory.card,vram.card);
  const selector=el('select');selector.setAttribute('aria-label','Monitored GPU');selector.hidden=true;selector.onchange=()=>{selectedGpu=selector.value;};header.append(selector);
  const summary=el('p','','diag-system-summary'),extras=el('p','','diag-system-extras');
  const details=el('details'),detailsTitle=el('summary','Processor, memory and storage details'),inventory=el('div','','diag-hardware-grid');details.append(detailsTitle,inventory);
  const note=el('p','Whole-system readings include Harbor and other applications. CPU/RAM refresh about every 1.5 s; GPU about every 3 s; drive details every 30 s.','diag-system-note');
  const temperatures=createTemperatureChart();
  const temperatureDetails=el('details');temperatureDetails.append(el('summary','Temperature history and sensors'),temperatures.element);
  element.append(header,grid,summary,extras,temperatureDetails,details,note);
  let hardwareStamp=null,gpuOptions='';
  function block(title,lines){const b=el('div','','diag-hardware-block');b.append(el('h3',title));for(const line of lines)b.append(el('p',line));return b;}
  function update(s){
    if(!s){for(const g of [cpu,gpu,memory,vram])g.set(null,'Waiting for system readings');return;}
    freshness.textContent=`Updated ${new Date(s.sampledAt).toLocaleTimeString()}`;
    temperatures.update(s.temperatures);
    cpu.set(s.cpu.utilizationPercent,`${s.cpu.logicalCpus} logical processors`);
    memory.set(s.memory.totalBytes>0?100*s.memory.usedBytes/s.memory.totalBytes:null,`${gib(s.memory.usedBytes)} / ${gib(s.memory.totalBytes)}`,'used');
    const devices=s.gpu?.devices??[],optionSignature=JSON.stringify(devices.map(g=>[g.index,g.name]));
    if(optionSignature!==gpuOptions){gpuOptions=optionSignature;selector.replaceChildren();for(const g of devices){const o=el('option',`GPU ${g.index}: ${g.name}`);o.value=String(g.index);selector.append(o);}if(!devices.some(g=>String(g.index)===selectedGpu))selectedGpu=String(devices[0]?.index??'');selector.value=selectedGpu;selector.hidden=devices.length<2;}
    const selected=devices.find(g=>String(g.index)===selectedGpu),live=s.gpu?.status==='ready'&&!s.gpu.stale;
    const unavailable=s.gpu?.stale?'Reading is stale':s.gpu?.status==='loading'?'Reading GPU…':'GPU sensor unavailable';
    gpu.set(live?selected?.utilizationPercent:null,live&&selected?selected.name:unavailable);
    vram.set(live&&selected?.memoryTotalMiB>0&&selected.memoryUsedMiB!==null?100*selected.memoryUsedMiB/selected.memoryTotalMiB:null,live&&selected?`${gib(selected.memoryUsedMiB===null?null:selected.memoryUsedMiB*2**20)} / ${gib(selected.memoryTotalMiB===null?null:selected.memoryTotalMiB*2**20)}`:unavailable,'used');
    summary.textContent=s.cpu.name;
    const hours=Math.floor(s.uptimeSeconds/3600),days=Math.floor(hours/24);
    const sensors=[];if(live&&selected){if(selected.temperatureC!==null)sensors.push(`GPU ${selected.temperatureC} °C`);if(selected.powerW!==null)sensors.push(`${selected.powerW.toFixed(0)} W`);if(selected.fanPercent!==null)sensors.push(`Fan ${selected.fanPercent}%`);}
    extras.textContent=[`Uptime ${days}d ${hours%24}h`,...sensors].join(' · ');
    const stamp=JSON.stringify([s.hardware?.sampledAt,s.hardware?.status]);
    if(stamp!==hardwareStamp){
      hardwareStamp=stamp;inventory.replaceChildren();const h=s.hardware?.data;
      if(h){
        inventory.append(block('Processor & operating system',[...(h.cpu??[]).map(c=>`${c.Name?.trim()} · ${c.NumberOfCores} cores / ${c.NumberOfLogicalProcessors} threads · Windows-reported clock ${(c.MaxClockSpeed/1000).toFixed(2)} GHz`),...(h.os??[]).map(o=>`${o.Caption} · build ${o.BuildNumber}`)]));
        inventory.append(block('Installed memory',[(h.memory??[]).length?`${h.memory.length} memory modules · ${gib(h.memory.reduce((a,m)=>a+Number(m.Capacity),0))} installed`:'Memory module details unavailable',...(h.memory??[]).map(m=>`${gib(Number(m.Capacity))} · ${m.ConfiguredClockSpeed||m.Speed||'Unknown'} MT/s · ${(m.Manufacturer??'').trim()} ${(m.PartNumber??'').trim()}`)]));
        inventory.append(block('Physical drives',(h.disks??[]).map(d=>`${d.Model?.trim()} · ${capacity(number(d.Size))} · ${d.InterfaceType}`)));
        inventory.append(block('Drive capacity & free space',(h.volumes??[]).map(v=>`${v.DeviceID} ${v.VolumeName||''} · ${capacity(number(v.FreeSpace))} free / ${capacity(number(v.Size))} · ${v.FileSystem||'Unknown format'}`)));
        inventory.append(block('Display adapters',(h.video??[]).map(v=>`${v.Name} · driver ${v.DriverVersion}`)));
        if(h.errors?.length)inventory.append(block('Unavailable details',h.errors));
      }else inventory.append(block('Hardware details',[s.hardware?.status==='loading'?'Reading processor, memory modules and disks…':s.hardware?.error||'Unavailable',s.platform]));
    }
  }
  update(null);return {element,update};
}
