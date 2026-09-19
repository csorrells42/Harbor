const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const svg=(tag,attrs,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
const colors=['#7ca5ff','#ffbc70','#75d9bc','#ef8dba','#c4a0ff','#e7df70','#83d6ed','#f18b83'];
const time=at=>new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
export function visibleTemperaturePoints(points,now,minutes){return points.filter(p=>p.at>=now-minutes*60000&&p.at<=now);}
export function temperaturePath(points,x,y,maxGapMs){let last=null;return points.map(p=>{if(!Number.isFinite(p.celsius)){last=null;return '';}const command=last!==null&&p.at-last<=maxGapMs?'L':'M';last=p.at;return `${command}${x(p.at).toFixed(2)},${y(p.celsius).toFixed(2)}`;}).join(' ');}
export function createTemperatureChart(){
  const element=el('section','','diag-temperature');element.setAttribute('aria-label','System temperature history');
  const header=el('div','','diag-system-heading');header.append(el('h2','Temperature history'));
  const ranges=el('div','','diag-temperature-ranges');ranges.setAttribute('role','group');ranges.setAttribute('aria-label','Temperature history window');
  let minutes=5,state=null,signature='',lastRendered='',hoverAt=null;
  const rangeButtons=new Map(),hidden=new Set(),legendItems=new Map();
  for(const m of [5,10,30,60]){const b=el('button',`${m} min`);b.type='button';b.setAttribute('aria-pressed',String(m===minutes));b.onclick=()=>{minutes=m;hoverAt=null;render();};rangeButtons.set(m,b);ranges.append(b);}header.append(ranges);
  const chart=svg('svg',{viewBox:'0 0 900 260',role:'img','aria-label':'Temperature history in degrees Celsius',class:'diag-temperature-chart'});
  const empty=el('p','Waiting for temperature sensors…','diag-temperature-empty'),readout=el('p','Move over the chart to inspect a reading.','diag-temperature-readout');
  const legend=el('div','','diag-temperature-legend');legend.setAttribute('aria-label','Temperature sensor legend');
  const coverage=el('p','','diag-system-note'),details=el('details'),summary=el('summary','Temperature sensor availability'),availability=el('div','','diag-temperature-sources');details.append(summary,availability);
  const note=el('p','Samples every 10 seconds after the first Diagnostics visit, including while using other tabs. Keeps up to 60 minutes for this Harbor session; restarting clears history. Gaps mean no reading.','diag-system-note');
  element.append(header,chart,empty,readout,legend,coverage,details,note);
  function inspect(at){
    if(!state)return;
    const values=state.series.filter(s=>!hidden.has(s.id)).map(s=>{const points=visibleTemperaturePoints(s.points,state.sampledAt,minutes);const p=points.reduce((a,p)=>!a||Math.abs(p.at-at)<Math.abs(a.at-at)?p:a,null);return p&&Math.abs(p.at-at)<=state.intervalMs*1.5&&Number.isFinite(p.celsius)?`${s.label}: ${p.celsius.toFixed(1)} °C`:null;}).filter(Boolean);
    readout.textContent=`${time(at)} · ${values.length?values.join(' · '):'No readings at this time'}`;
  }
  chart.addEventListener('pointermove',event=>{if(!state)return;const r=chart.getBoundingClientRect(),pixel=(event.clientX-r.left)*900/r.width;hoverAt=state.sampledAt-minutes*60000+(Math.max(55,Math.min(875,pixel))-55)/820*minutes*60000;inspect(hoverAt);});
  chart.addEventListener('pointerleave',()=>{hoverAt=null;readout.textContent='Move over the chart to inspect a reading. Legend shows latest, minimum and maximum for the selected window.';});
  function render(){
    for(const [m,b] of rangeButtons)b.setAttribute('aria-pressed',String(m===minutes));
    chart.replaceChildren();if(!state)return;
    const now=state.sampledAt,start=now-minutes*60000;
    const visible=state.series.map((s,i)=>({...s,color:colors[i%colors.length],index:i,points:visibleTemperaturePoints(s.points,now,minutes)}));
    const values=visible.filter(s=>!hidden.has(s.id)).flatMap(s=>s.points.map(p=>p.celsius).filter(Number.isFinite));
    const low=Math.min(0,Math.floor(Math.min(...values,0)/10)*10),high=Math.max(50,Math.ceil(Math.max(...values,50)/10)*10);
    const x=at=>55+(at-start)/(minutes*60000)*820,y=c=>220-(c-low)/(high-low)*195;
    chart.append(svg('title',{},`Last ${minutes} minutes of system temperatures. ${visible.length} sensors. Values in degrees Celsius.`));
    for(let i=0;i<=5;i++){const value=low+(high-low)*i/5;chart.append(svg('line',{x1:55,x2:875,y1:y(value),y2:y(value),class:'diag-temperature-grid'}),svg('text',{x:45,y:y(value)+4,'text-anchor':'end',class:'diag-temperature-axis'},`${Math.round(value)}°`));}
    for(let i=0;i<=4;i++){const at=start+(now-start)*i/4;chart.append(svg('text',{x:x(at),y:245,'text-anchor':i===0?'start':i===4?'end':'middle',class:'diag-temperature-axis'},new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));}
    for(const s of visible){
      if(!hidden.has(s.id)){
        chart.append(svg('path',{d:temperaturePath(s.points,x,y,state.intervalMs*2.5),fill:'none',stroke:s.color,'stroke-width':2,'stroke-dasharray':s.index<8?'none':`${2+s.index%4*2} 4`,'data-sensor-id':s.id}));
        const latest=s.points.filter(p=>Number.isFinite(p.celsius)).at(-1);
        if(latest){const dot=svg('circle',{cx:x(latest.at),cy:y(latest.celsius),r:3,fill:s.color});dot.append(svg('title',{},`${s.label}: ${latest.celsius} °C at ${time(latest.at)}`));chart.append(dot);}
      }
      let item=legendItems.get(s.id);
      if(!item){const label=el('label'),check=el('input');check.type='checkbox';check.checked=!hidden.has(s.id);check.setAttribute('aria-label',`Show temperature sensor ${s.label}`);check.onchange=()=>{check.checked?hidden.delete(s.id):hidden.add(s.id);render();};const swatch=svg('svg',{viewBox:'0 0 20 12','aria-hidden':'true'}),line=svg('line',{x1:1,x2:19,y1:6,y2:6,'stroke-width':3});swatch.append(line);const text=el('span');label.append(check,swatch,text);legend.append(label);item={label,text,line};legendItems.set(s.id,item);}
      item.line.setAttribute('stroke',s.color);item.line.setAttribute('stroke-dasharray',s.index<8?'none':`${2+s.index%4*2} 4`);
      const measured=s.points.filter(p=>Number.isFinite(p.celsius)),last=s.points.at(-1),fresh=last&&Number.isFinite(last.celsius)&&now-last.at<=state.intervalMs*2.5;
      item.text.textContent=`${s.label} · ${fresh?last.celsius.toFixed(1)+' °C':'unavailable'}${measured.length?` · min ${Math.min(...measured.map(p=>p.celsius)).toFixed(1)} / max ${Math.max(...measured.map(p=>p.celsius)).toFixed(1)} °C`:''}`;
      item.label.title=`Source: ${s.source}${last?` · last sample ${time(last.at)}`:''}`;
    }
    for(const [id,item] of legendItems)if(!visible.some(s=>s.id===id)){item.label.remove();legendItems.delete(id);hidden.delete(id);}
    empty.hidden=values.length>0;empty.textContent=visible.length&&visible.every(s=>hidden.has(s.id))?'Select a sensor in the legend to show its history.':'No measured temperatures in this time window yet.';
    const earliest=visible.flatMap(s=>s.points).filter(p=>Number.isFinite(p.celsius)).reduce((a,p)=>Math.min(a,p.at),Infinity);
    coverage.textContent=`Last ${minutes} minutes · ${visible.length} detected sensor${visible.length===1?'':'s'}${Number.isFinite(earliest)?` · readings available since ${time(earliest)}`:' · collecting available sensors'}. No earlier readings are invented.`;
    const next=JSON.stringify(state.providers);if(next!==signature){signature=next;availability.replaceChildren();for(const p of state.providers)availability.append(el('p',`${p.name}: ${p.status} — ${p.detail}`));if(!state.providers.length)availability.append(el('p','Checking sensor providers…'));availability.append(el('p','CPU cores, motherboard and other sensors appear when an accessible LibreHardwareMonitor or OpenHardwareMonitor WMI provider exposes them. ACPI zones are not assumed to be CPU temperatures.'));}
    if(hoverAt!==null)inspect(hoverAt);
  }
  return {element,update(s){if(!s)return;state=s;const stamp=JSON.stringify([Math.floor(s.sampledAt/1000),s.providers,s.series]);if(stamp!==lastRendered){lastRendered=stamp;render();}}};
}
