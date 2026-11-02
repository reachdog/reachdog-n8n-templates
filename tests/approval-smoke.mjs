// Run with an installed n8n CLI: node tests/approval-smoke.mjs <path-to-n8n/bin/n8n>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const cli=resolve(process.argv[2]),dir=await mkdtemp(join(tmpdir(),'rd-n8n-approvals-'));
async function n8n(...args){
 try{await promisify(execFile)(process.execPath,[cli,...args],{windowsHide:true,timeout:150000,maxBuffer:4e6,env});}
 catch(e){throw Error(e.stdout.slice(-4500)+e.stderr.slice(-1000));}
}
const env={...process.env,N8N_USER_FOLDER:dir,N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_ENCRYPTION_KEY:randomUUID()};
const products=[{id:11,client_product_id:'11',title:'Tea'},{id:22,client_product_id:'22',title:'Coffee'}];
const rows=new Map(),keys=new Set();
let accepted=0;
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://test');let raw='';for await(const chunk of req)raw+=chunk;
 let body;
 if(u.pathname==='/source')body=products;
 else if(u.pathname==='/write'){
   const row=JSON.parse(raw);rows.set(row.client_product_id,row);body={};
 }else if(u.pathname==='/v1/usage')body={parameter_price:2};
 else if(u.pathname==='/v1/title-matches'){
   if (!/^rdn8n-audit-[a-f0-9]{64}$/.test(req.headers['idempotency-key'])) {res.statusCode=422;return res.end(JSON.stringify({code:'missing_key'}));}keys.add(req.headers['idempotency-key']);
   res.setHeader('x-charge-state','settled');res.setHeader('x-charged-tokens','6');
   body={product_type:'beverage',missing_attributes:[],taxonomy_mappings:[]};
 }else if(u.pathname==='/v1/batches'){
   assert.match(req.headers['idempotency-key'],/^rdn8n-catalog-[a-f0-9]{64}$/);
   body={id:'job',status:'awaiting_acceptance',billing:{quote:{amount:6},acceptance:'binding'}};
 }else if(u.pathname.endsWith('/accept')){
   assert.equal(req.headers['idempotency-key'],undefined);assert.equal(JSON.parse(raw).acceptance,'binding');accepted++;
   body={id:'job',status:'completed',result_available:true,billing:{state:'settled'}};
 }else if(u.pathname.endsWith('/results')){
   assert.equal(accepted,1);body={has_more:false,outputs:{catalog_products:products.map(p=>({...p,client_product_id:'shopify-'+p.id})),group_members:[],catalog_groups:[]}};
 }else{res.statusCode=404;body={code:'unexpected_path'};}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{
 for(const [index,file] of ['product-feed-audit','shopify-catalog-groups'].entries()){
  const path=fileURLToPath(new URL('../templates/'+file+'.json',import.meta.url));
  await n8n('import:workflow','--input='+path);
  const wf=JSON.parse(await readFile(path));wf.id='ReachDogSmoke00'+index;
  const node=name=>wf.nodes.find(n=>n.name===name);
  const http=(name,parameters)=>Object.assign(node(name),{type:'n8n-nodes-base.httpRequest',typeVersion:4.2,parameters});
  const cfg={api_origin:'https://test.invalid',spreadsheet_id:'test',run_label:''};
  for(const v of node('Configuration').parameters.assignments.assignments)v.value=cfg[v.name];
  http('Read source',{url:base+'/source',options:{}});
  for(const n of wf.nodes.filter(n=>n.name.endsWith('Reach Dog'))) Object.assign(n.parameters,{authentication:'none',url:'='+base+'{{ $json.path }}'});
  Object.assign(node('Approval form'),{type:'n8n-nodes-base.code',typeVersion:2,parameters:{jsCode:"return [{json:{decision:'Approve'}}];"}});
  http('Write results',{url:base+'/write',method:'POST',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}});
  const testPath=join(dir,file+'.json');await writeFile(testPath,JSON.stringify(wf));
  await n8n('import:workflow','--input='+testPath);
  await n8n('execute','--id='+wf.id);
  assert.equal(rows.size,2);
  if(!index){await n8n('execute','--id='+wf.id);assert.equal(keys.size,2);assert.equal(rows.size,2);}
  else{assert.equal(accepted,1);assert.equal(rows.get('shopify-11').ungrouped,true);}
  rows.clear();console.log('Passed '+file);
 }
} finally{await new Promise(r=>server.close(r));}
