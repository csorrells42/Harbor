export const HISTORY_MS=60*60*1000;
export const SAMPLE_MS=10000;
export function validTemperature(value){return typeof value==='number'&&Number.isFinite(value)&&value>=-100&&value<=200;}
export function createTemperatureHistory(){
  const series=new Map();
  function prune(now){for(const [id,s] of series){s.points=s.points.filter(p=>p.at>=now-HISTORY_MS&&p.at<=now);if(!s.points.some(p=>p.celsius!==null))series.delete(id);}}
  return {
    record(source,readings,at){
      const observed=new Map(readings.filter(r=>typeof r.id==='string'&&validTemperature(r.celsius)).map(r=>[r.id,r]));
      for(const [id,r] of observed)if(!series.has(id))series.set(id,{id,label:r.label||id,source,points:[]});
      for(const s of series.values())if(s.source===source){const r=observed.get(s.id),p={at,celsius:r?.celsius??null};if(r)s.label=r.label||s.label;if(s.points.at(-1)?.at===at)s.points[s.points.length-1]=p;else s.points.push(p);}
      prune(at);
    },
    snapshot(now){prune(now);return [...series.values()].map(s=>({...s,points:s.points.map(p=>({...p}))}));},
  };
}
export function parseNvidiaTemperatures(output){
  return output.trim().split(/\r?\n/).filter(Boolean).flatMap(line=>{
    const p=line.split(',').map(s=>s.trim());if(p.length<3||p.length>4)throw new Error('Unsupported NVIDIA temperature response');
    return [['core',p[2]],['memory',p[3]]].flatMap(([kind,raw])=>{const n=raw?.trim()?Number(raw):NaN;return validTemperature(n)?[{id:`nvidia/${p[0]}/${kind}`,label:`GPU ${p[0]} ${p[1]} · ${kind}`,celsius:n}]:[];});
  });
}
