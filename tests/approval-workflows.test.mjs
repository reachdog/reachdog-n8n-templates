import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const load = name => JSON.parse(readFileSync(new URL('../templates/'+name+'.json',import.meta.url)));
const catalog=load('shopify-catalog-groups'),audit=load('product-feed-audit');
function run(wf,name,rows,refs={}) {
 const src=wf.nodes.find(n=>n.name===name).parameters.jsCode;
 const items=rows.map(json=>({json}));
 const previous=name=>({last:()=>({json:refs[name]}),first:()=>({json:refs[name]})});
 return Function('$input','$','$execution',src)({all:()=>items,first:()=>items[0]},previous,{id:'test'}).map(x=>x.json);
}
const cfg={Configuration:{api_origin:'https://mock.invalid',spreadsheet_id:'test',run_label:''}};
test('both workflow gates stop on rejection or expiry',()=>{
 for(const wf of [catalog,audit]){
  assert.equal(wf.active,false);
  const form=wf.nodes.find(n=>n.name==='Approval form');
  assert.equal(form.parameters.resume,'form');assert.equal(form.parameters.limitWaitTime,true);
  for(const reply of [{decision:'Reject'},{},{step:'quote'}])assert.deepEqual(run(wf,'Apply decision',[reply]),[]);
  assert.equal(run(wf,'Apply decision',[{decision:'Approve'}],{'Handle response':{batch_path:'/batch',acceptance:'quoted',records:[{}]}})[0].step,wf===catalog?'accept':'row');
 }
});
test('exclude duplicates and empty titles, and enforce whole-store limit',()=>{
 const r=run(audit,'Prepare input',[{client_product_id:'x',title:'one'},{client_product_id:'x',title:'two'},{title:'missing ID'},{client_product_id:'good',title:'ok'}],cfg)[0];
 assert.equal(r.excluded.length,3);assert.equal(r.records.length,1);
 assert.throws(()=>run(catalog,'Prepare input',Array(501).fill({}),cfg),/500/);
 assert.equal(run(catalog,'Prepare input',[{id:3,title:' '}],cfg)[0].excluded.length,1);
});
test('estimate, quota error and transient retries preserve the row',()=>{
 const ref={'Hash request':{step:'usage',records:[{},{}]}};
 const response=(code,body,headers={})=>({statusCode:code,body:JSON.stringify(body),headers});
 assert.match(run(audit,'Handle response',[response(200,{parameter_price:3})],ref)[0].approval_text,/18 estimated/);
 assert.throws(()=>run(audit,'Handle response',[response(200,{})],ref),/no price/);
 ref['Hash request']={step:'row',index:0,records:[{client_product_id:'p',title:'t'}]};
 const wait=run(audit,'Handle response',[response(503,{}, {'retry-after':'2'})],ref)[0];
 assert.equal(wait.route,'wait');assert.equal(wait.delay,2);assert.equal(wait.index,0);
 const failed=run(audit,'Handle response',[response(429,{code:'quota_exceeded'})],ref)[0];
 assert.equal(failed.row.error,'quota_exceeded');
 assert.throws(()=>run(audit,'Next row',[{}],{'Handle response':failed}),/quota_exceeded/);
});
test('catalog refusal stops and pages join by product and group IDs',()=>{
 const handle=(s,b)=>run(catalog,'Handle response',[{statusCode:200,body:JSON.stringify(b)}],{'Hash request':s})[0];
 const refusal=handle({step:'status'},{id:'job',status:'failed',billing:{state:'refused'},error:{code:'wallet_frozen'}});
 assert.equal(refusal.route,'error');
 let s=handle({step:'status'},{id:'job',status:'completed',result_available:true,billing:{state:'settled'}});
 s=handle(s,{has_more:true,next_cursor:'a+b',outputs:{catalog_products:[{client_product_id:'x',title:'Tea'}],group_members:[],catalog_groups:[{id:'g',label:'Tea'}]}});
 assert.match(s.path,/a%2Bb$/);
 s=handle(s,{has_more:false,outputs:{catalog_products:[],catalog_groups:[],group_members:[{id:'g',members:[{client_product_id:'x'}]}]}});
 assert.equal(s.rows[0].group_label,'Tea');assert.equal(s.rows[0].ungrouped,false);
});
