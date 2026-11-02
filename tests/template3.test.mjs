import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

const workflow = JSON.parse(await readFile(new URL('../templates/shopify-product-keywords.json', import.meta.url)));
const node = name => workflow.nodes.find(n => n.name === name);
function runCode(name, value, index = 0) {
  const product = {body:{title:'Test product',client_product_id:'shopify-12'}};
  return Function('$input','$runIndex','$', node(name).parameters.jsCode)(
    {first:()=>({json:value})}, index, ()=>({first:()=>({json:product})})
  )[0].json;
}

test('retry only transient failures, respect Retry-After, and stop after four attempts', () => {
  for (const op of ['Usage','Title match']) {
    const classify = (r,i) => runCode('Classify '+op,r,i);
    assert.equal(classify({statusCode:429}).retry,false);
    assert.equal(classify({statusCode:503,headers:{'retry-after':'7'}}).delay,7);
    assert.equal(classify({error:'response lost'}).retry,true);
    assert.equal(classify({statusCode:503},3).retry,false);
  }
});

test('unknown charges remain held and settled zero is a valid receipt', () => {
  const classify = r => runCode('Interpret receipt', r);
  assert.equal(classify({error:'socket closed'}).state,'held');
  const rejected = {statusCode:429,body:JSON.stringify({code:'quota_exceeded'})};
  assert.equal(classify({...rejected,attempts:1}).state,'released');
  assert.equal(classify({...rejected,attempts:2}).state,'held');
  const result = classify({statusCode:200,body:'{"search_phrases":[],"search_volume":[]}',
    headers:{'x-charge-state':'settled','x-charged-tokens':'0'}});
  assert.equal(result.state,'settled');
  assert.equal(result.row.charged_tokens,'0');
  assert.equal(result.row.status,'completed');
});

test('reservations survive a failed execution and serialize concurrent admissions', async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const databaseDir = await mkdtemp(join(tmpdir(),'rd-budget-test-'));
  const server = new EmbeddedPostgres({databaseDir, port, password:randomUUID(), persistent:false,onLog:()=>{}});
  await server.initialise();
  await server.start();
  t.after(()=>server.stop());
  const connect = async () => {
    const db = server.getPgClient();
    await db.connect();
    return db;
  };
  const first = await connect(), second = await connect(), observer = await connect();
  let disconnected = false;
  try {
    await first.query(await readFile(new URL('../sql/template3-budget.sql',import.meta.url),'utf8'));
    const key = suffix => 'rdn8n-keywords-' + suffix.repeat(64);
    const reserve = async (db,id,execution,estimate=6) =>
      (await db.query(node('Reserve budget').parameters.query,['account',key(id),execution,estimate,10])).rows[0];
    const finish = async (id,owner,state,amount,row) =>
      second.query(node('Record outcome').parameters.query,['account',key(id),owner,state,amount,JSON.stringify(row)]);
    await first.query('BEGIN');
    assert.equal((await reserve(first,'a','first')).decision,'send');
    const competing = reserve(second,'b','second');
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const {rows:[activity]} = await Promise.race([
          observer.query('SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',
            [second.processID]),
          competing.then(row => assert.fail('B finished before waiting for A: ' + row.decision))
        ]);
        if (activity.wait_event_type === 'Lock' && activity.blockers.includes(first.processID)) break;
        assert.ok(Date.now() < deadline, 'B never waited on a lock held by A');
        await delay(10);
      }
      await first.query('COMMIT');
      assert.equal((await competing).decision,'cap');
    } finally {
      // Unblock B even if a lock assertion failed with A still in its transaction.
      if (first.getTransactionStatus() === 'T') await first.query('ROLLBACK');
      await competing;
    }
    await first.end(); disconnected = true; // Worker disappears after sending the paid request, before saving the receipt.
    assert.equal((await reserve(second,'a','duplicate')).decision,'held');
    assert.equal((await reserve(second,'c','third')).decision,'cap');
    await assert.rejects(finish('a','duplicate','released',0,{}),/owned by another execution/);
    const row = {client_product_id:'shopify-12',status:'completed'};
    await finish('a','first','settled',4,row);
    assert.deepEqual(await reserve(second,'a','replay'),{decision:'settled',cached_row:row});
    assert.equal((await reserve(second,'b','second')).decision,'send');
    await finish('b','second','released',0,{status:'quota_exceeded'});
    assert.equal((await reserve(second,'b','fourth')).decision,'send');
    assert.equal((await reserve(second,'c','third',1)).decision,'cap');
    await second.query("UPDATE rd_keywords.operations SET admitted_day = admitted_day - 1");
    assert.equal((await reserve(second,'c','next-day')).decision,'send');
    assert.equal((await reserve(second,'b','repeated-next-day')).decision,'held');
  } finally {
    if (!disconnected) await first.end();
    await second.end();
    await observer.end();
  }
});
