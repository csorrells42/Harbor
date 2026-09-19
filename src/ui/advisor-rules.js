// Exact configured IDs only. Rules are local hints, never capability or auth checks.
export const categories = [['research','Research'],['coding','Coding'],['files','Files / documents'],['browser','Browser testing'],['debugging','Debugging'],['planning','Planning'],['offline','Offline / local']];
const catalog = {
  dbhub: {tasks:[],optional:['coding','research','planning','offline'],reason:'Query and edit a persistent local SQLite database, inspect tables and schemas, or connect to other database systems.',internet:'local'},
  duckdb: {tasks:['research'],optional:['files','coding','offline'],reason:'Query CSV, Parquet and local databases with DuckDB; calculate totals and joins without a cloud account.',warnings:['Read-write SQL is enabled. In-memory results disappear on restart; switch to a chosen database file to keep them.'],internet:'local'},
  markitdown: {tasks:['files'],optional:['research','offline'],reason:'Convert Office documents, PDFs and HTML into Markdown for reading and analysis.',warnings:['Preserves readable content rather than original page layout. Optional cloud and media features need additional services or runtimes.'],internet:'conditional'},
  excel: {tasks:['files'],optional:['research','planning','offline'],reason:'Create and edit Excel workbooks, worksheets, formulas, formatting and charts without Excel installed.',warnings:['Formulas are saved but not recalculated. Cached values can be absent or stale until a calculation engine opens the workbook.'],internet:'local'},
  word: {tasks:['files'],optional:['planning','offline'],reason:'Create and edit Word documents with headings, tables, images, comments and tracked changes.',warnings:['Use a unique document handle for each concurrent editing workflow. This is an extensive tool set; start it for document tasks.'],internet:'local'},
  'typst-mcp': {tasks:['files'],optional:['research','planning','offline'],reason:'Create and revise PDFs with the bundled Typst typesetter; includes document structure, bibliography and compile tools.',warnings:['Typst authoring is available locally. Optional LaTeX tools need a separately provisioned TeX engine.'],internet:'local'},
  serena: {tasks:['coding','debugging'],optional:['offline'],reason:'Semantic code navigation and editing in your chosen project.',warnings:['Can edit project files and execute commands. Confirm the active project.']},
  'pdf-tools': {tasks:['files'],optional:['research','offline'],reason:'Merge, split, reorder, annotate and convert existing PDFs; extract text, tables and images.',warnings:['PDF tools write to the paths you choose. Markdown-to-PDF uses the bundled Typst engine. OCR needs Tesseract, which is not bundled.'],internet:'local'},
  context7: {tasks:['coding'],optional:['research','debugging'],reason:'Retrieve current library documentation for implementation details.',internet:'required'},
  github: {tasks:[],optional:['coding','research','planning'],reason:'Hosted repository issues, pull requests and collaboration when needed.',internet:'required',warnings:['Powerful permission: GitHub includes write tools. Check account and repository scope.']},
  playwright: {tasks:['browser'],optional:['research','debugging','offline'],reason:'Exercise browser behavior and inspect rendered pages; local sites can work offline.',internet:'conditional',warnings:['Browser automation can access signed-in pages and execute code. Not a security sandbox.']},
  exa: {tasks:['research'],reason:'Search the web for sources.',internet:'required',warnings:['Verify fetched content: an Exa fetch probe returned unrelated cached content without an error. Use direct Fetch or Playwright for source verification.']},
  'brave-search': {tasks:[],optional:['research'],reason:'Alternative web search when a Brave key is configured.',setup:'Brave API key',internet:'required',warnings:['Requires BRAVE_API_KEY_FILE for the installed launch configuration. Missing key fails closed.']},
  'desktop-commander': {tasks:[],optional:['files','coding','debugging','offline'],reason:'Broad desktop and process operations only when narrower tools are insufficient.',warnings:['Powerful permission: host shell and filesystem access, not a machine sandbox. Commands may use the network.']},
  fetch: {tasks:['research'],reason:'Read a direct source URL without starting browser automation.',internet:'required',warnings:['Check the returned source and content; fetching remote URLs sends network requests.']},
  'git-local': {tasks:['coding','offline'],optional:['debugging'],reason:'Inspect local repository history and changes. Choose the intended repository; a dedicated empty repo has no project history.',warnings:['Git tools can change the local repository. Confirm its configured path.']},
  memory: {tasks:['planning'],optional:['research','coding','offline'],reason:'Keep reusable notes and relationships in shared local storage.',warnings:['Shared persistent memory: no secrets. Connected apps share this storage.']},
  filesystem: {tasks:['files','offline'],optional:['coding'],reason:'Read and edit files in the configured workspace.',warnings:['Write access within configured roots. Check paths; local does not imply read-only.']},
  'sequential-thinking': {tasks:['planning'],optional:['debugging','coding','offline'],reason:'Structure work step by step; not a separate model or an AI API.'}
};
const groups=[['exa','brave-search'],['filesystem','desktop-commander']];
export const tierLabels = {'recommended':'Recommended','optional':'Optional','not-needed':'Not needed','needs-setup':'Needs setup'};
export function advise(servers, {category='research', selected=new Set(), internet=true, verified=new Set()}={}) {
  return servers.map(server=>{
    const rule=Object.hasOwn(catalog,server.id)?catalog[server.id]:null;
    const network=rule?.internet??(rule?'local':'unknown');
    let tier=!rule?'optional':rule.tasks.includes(category)?'recommended':rule.optional?.includes(category)?'optional':'not-needed';
    let reason=rule?.reason??'No local recommendation rule for this custom server. Review its configuration and tools; internet and permissions are unknown.';
    if(tier==='not-needed')reason=`Not usually needed for ${categories.find(([id])=>id===category)?.[1]??'this task'}. ${reason}`;
    const warnings=[...(rule?.warnings??[])];
    let selectable=true;
    if(rule?.setup&&server.status!=='running'&&!verified.has(server.id)){
      tier='needs-setup';selectable=false;reason=`${rule.setup} has not been verified. Configure, then start individually in Children Servers Statuses after setup.`;
    } else if(network==='required'&&(!internet||category==='offline')){
      tier='not-needed';selectable=false;reason=`Internet unavailable for this task: ${reason}`;
    }
    const group=groups.find(ids=>ids.includes(server.id));
    const alternatives=servers.filter(other=>other.id!==server.id&&group?.includes(other.id)&&(selected.has(other.id)||other.status==='running'));
    if(alternatives.length){
      const peers=alternatives.map(other=>`${other.name} (${other.status==='running'?'running':'selected'})`).join(', ');
      warnings.push(`Overlap with ${peers}: prefer one for shared capabilities; keep both only for distinct needs.`);
      if(tier==='recommended'&&!selected.has(server.id)&&server.status!=='running'){tier='optional';reason+=` Already covered in part by ${peers}.`;}
    } else if(group&&selected.has(server.id))warnings.push('Overlap: this selection can cover part of the task; alternatives are optional.');
    return {server,tier,reason,warnings,internet:network,selected:selected.has(server.id),selectable};
  });
}
