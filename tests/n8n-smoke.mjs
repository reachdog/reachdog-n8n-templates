// Run: node tests/n8n-smoke.mjs /absolute/path/to/n8n/bin/n8n
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const cli = resolve(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(),'rd-n8n-test-'));
const env = {...process.env, N8N_USER_FOLDER:dir, N8N_DIAGNOSTICS_ENABLED:'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED:'false', N8N_ENCRYPTION_KEY:randomUUID()};
async function n8n(...args) {
  try { await promisify(execFile)(process.execPath,[cli,...args],{env,windowsHide:true,timeout:150000,maxBuffer:4e6}); }
  catch (error) { throw new Error(error.stdout.slice(-5500) + error.stderr.slice(-1500)); }
}
async function listen(server) {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return server.address().port;
}
const probe = createServer();
const port = await listen(probe);
await new Promise(done => probe.close(done));
const password = randomUUID();
const db = new EmbeddedPostgres({databaseDir:join(dir,'db'),port,password,persistent:false,onLog:()=>{}});
let posts = 0, product = 12, failSheet = true;
const rows = [];
const mock = createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if (req.url === '/product') return res.end(JSON.stringify({id:product,title:'Test'}));
  if (req.url === '/usage') return res.end('{"parameter_price":2}');
  if (req.url === '/title') {
    posts++;
    assert.match(req.headers['idempotency-key'],/^rdn8n-keywords-[a-f0-9]{64}$/);
    res.setHeader('x-charge-state','settled');
    res.setHeader('x-charged-tokens','4');
    return res.end('{"search_phrases":[],"search_volume":[]}');
  }
  if (req.url === '/sheet') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (failSheet) { res.statusCode = 503; return res.end('{}'); }
    rows.push(JSON.parse(raw));
    return res.end('{}');
  }
  res.statusCode=404; res.end('{}');
});
const base = 'http://127.0.0.1:' + await listen(mock);
try {
  await db.initialise();
  await db.start();
  const client = db.getPgClient();
  await client.connect();
  await client.query(await readFile(new URL('../sql/template3-budget.sql',import.meta.url),'utf8'));
  await client.end();
  const file = new URL('../templates/shopify-product-keywords.json',import.meta.url);
  await n8n('import:workflow','--input='+fileURL(file));
  const wf=JSON.parse(await readFile(file));
  wf.id='Template3Smoke01';
  const node = name => wf.nodes.find(n=>n.name===name);
  const setHttp = (name,p) => Object.assign(node(name),{type:'n8n-nodes-base.httpRequest',typeVersion:4.2,parameters:p});
  // Exercise the real graph and DB nodes, substituting only the external service boundaries.
  wf.nodes.push({id:'test-start',name:'Manual',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[-200,0],parameters:{}});
  wf.connections.Manual = {main:[[{node:'New product',type:'main',index:0}]]};
  setHttp('New product',{url:base+'/product',options:{}});
  const config = {api_origin:'https://test.invalid',account:'shop',daily_cap:'4',run_label:'',spreadsheet_id:'test'};
  for (const x of node('Configuration').parameters.assignments.assignments) x.value=config[x.name];
  for (const [name,path] of [['Usage','/usage'],['Title match','/title']]) {
    Object.assign(node(name).parameters,{url:base+path,authentication:'none'});
  }
  for (const name of ['Reserve budget','Record outcome']) node(name).credentials={postgres:{id:'TestPgCredential',name:'Test DB'}};
  setHttp('Write keywords',{method:'POST',url:base+'/sheet',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}});
  await writeFile(join(dir,'workflow.json'),JSON.stringify(wf));
  await writeFile(join(dir,'creds.json'),JSON.stringify([{id:'TestPgCredential',name:'Test DB',type:'postgres',
    data:{host:'127.0.0.1',port,database:'postgres',user:'postgres',password,ssl:'disable',allowUnauthorizedCerts:false}}]));
  await n8n('import:credentials','--input='+join(dir,'creds.json'));
  await n8n('import:workflow','--input='+join(dir,'workflow.json'));
  const execute=()=>n8n('execute','--id='+wf.id);
  await assert.rejects(execute(), err => { if (posts !== 1) throw err; return true; });
  assert.equal(posts,1,'paid request should have succeeded before the failed sheet write');
  failSheet=false;
  await execute();
  assert.equal(posts,1);
  assert.equal(rows[0].status,'completed');
  product++;
  await execute();
  assert.equal(posts,1);
  assert.equal(rows[1].status,'skipped: daily cap reached');
  console.log('PASS: n8n import, paid request, sheet failure, cached replay, cap skip');
} finally {
  await new Promise(done => mock.close(done));
  await db.stop();
}
import {fileURLToPath as fileURL} from 'node:url';
