const root='${HARBOR_ROOT}',node=`${root}/runtimes/node/node.exe`;
const steps=id=>({build:[{command:node,args:[`${root}/support/build-delivery.mjs`,root,id,'${STAGE}']}],verify:[{command:node,args:[`${root}/support/verify-delivery-component.mjs`,root,id,'${STAGE}']}]});
export const deliveryComponents=[
  {id:'fastmcp-tools',name:'FastMCP tool discovery and Code Mode',path:'packages/fastmcp-tools',excludeFromStage:['python'],update:[{command:node,args:[`${root}/support/build-delivery.mjs`,root,'fastmcp-lock','${STAGE}']}],...steps('fastmcp-tools'),notes:'Updates the FastMCP 4.x published release and lockfile, builds with bundled Python, then checks search and code execution before activation.'},
  {id:'portkey-tools',name:'Portkey semantic tool search',path:'packages/portkey-tools',repository:'https://github.com/Portkey-AI/mcp-tool-filter.git',generatedPaths:['dist'],...steps('portkey-tools'),notes:'Updates upstream source while retaining Harbor CPU batching and model cleanup patches. Verifies local semantic retrieval before activation. Four bundled models stay in runtimes/embedding-models.'}
];
