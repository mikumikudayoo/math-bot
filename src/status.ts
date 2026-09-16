const labels:Record<string,string>={
  'searching Discord':'🔎 searching Discord...','looking up member':'👤 looking up member...',
  thinking:'💭 thinking...',searching:'🔎 searching...',calculating:'🧮 calculating...',plotting:'📊 plotting...',
  'examining image':'👁️ examining image...','preparing answer':'✍️ preparing answer...',
  'reading a source':'📖 reading a source...','running sandboxed Python':'🐍 running sandboxed Python...',
};
export function statusText(status:string,state:string) {
  if(state==='queued')return `⏳ ${status}`;
  return labels[status]??labels.thinking!;
}
