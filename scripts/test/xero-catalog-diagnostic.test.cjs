'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readXeroCatalog,QUERIES,OBJECTS}=require('../xero-catalog-diagnostic.cjs');

function fixture(overrides={}) {
  const state={begins:0,rollbacks:0,queries:[]};
  const rows={
    observer:[{server_name:'forit-saas-sql',database_name:'forit',
      principal_name:'github-actions-forit-xero',original_login:'product-login',
      authentication_type_desc:'EXTERNAL',is_owner:0,is_security_admin:0,database_control:0,
      database_definition:0,schema_definition:0,observed_at:new Date('2026-11-21T11:00:00Z')}],
    objects:OBJECTS.map((name,i)=>({requested_name:name,object_id:i+1,type_desc:'USER_TABLE'})),
    columns:[],constraints:[],foreign_keys:[],row_policies:[],principal:[],
    roles:[{principal_id:0,principal_name:'public',depth:0}],permissions:[],...overrides,
  };
  class Transaction {
    async begin(){state.begins++;if(state.failBegin)throw new Error('private-driver-details');}
    async rollback(){state.rollbacks++;if(state.failRollback)throw new Error('private-driver-details');}
  }
  class Request {
    constructor(tx){assert.ok(tx instanceof Transaction);}
    async query(query){
      state.queries.push(query);
      assert.equal('timeout' in this,false,'no unsupported Request.timeout field');
      const name=Object.keys(QUERIES).find(key=>QUERIES[key]===query);
      assert.ok(name,'only the fixed query catalogue is called');
      if(state.failQuery===name)throw new Error('private-driver-details');
      return {recordset:rows[name]};
    }
  }
  const deps={pool:{config:{requestTimeout:15000}},sql:{Transaction,Request}};
  return {state,rows,deps,run:()=>readXeroCatalog(deps)};
}

test('one fixed read-only transaction, fixed targets and timeout, never business rows',async()=>{
  const f=fixture();const receipt=await f.run();
  assert.equal(f.state.begins,1);assert.equal(f.state.rollbacks,1);
  assert.equal(f.state.queries.length,Object.keys(QUERIES).length);
  assert.equal(f.deps.pool.config.requestTimeout,15000);
  assert.equal(receipt.transaction,'ROLLED_BACK');assert.equal(receipt.row_data_read,false);
  assert.equal(receipt.access_changed,false);assert.match(receipt.source_sha256,/^[a-f0-9]{64}$/);
  assert.equal(receipt.effective_website_rights,'NOT_EVALUATED_AS_WEBSITE');
  for(const query of Object.values(QUERIES)){
    assert.match(query.trim(),/^(SELECT|WITH)\b/);
    assert.doesNotMatch(query,/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|CREATE|ALTER|DROP|GRANT|DENY|REVOKE|OPENROWSET|OPENDATASOURCE)\b|SELECT\s+\*/i);
    assert.doesNotMatch(query,/\b(FROM|JOIN)\s+xero\./i);
    assert.doesNotMatch(query,/predicate_definition|default_definition|computed_definition/i);
  }
});

test('no caller SQL, target, credential or principal override is accepted',async()=>{
  for(const extra of ['query','server','database','principal','token','customer_id']){
    const f=fixture();await assert.rejects(readXeroCatalog({...f.deps,[extra]:'input'}),/dependencies refused/);
    assert.equal(f.state.begins,0);
  }
});

test('missing, unlimited, oversized or malformed driver timeout refuses before any transaction',async()=>{
  for(const value of [undefined,null,0,-1,15001,Infinity,NaN,'15000']){
    const f=fixture();f.deps.pool.config.requestTimeout=value;
    await assert.rejects(f.run(),/bounded requestTimeout/);
    assert.equal(f.state.begins,0);assert.equal(f.state.queries.length,0);
  }
  const f=fixture();f.deps.pool.config.requestTimeout=1000;await f.run();
  assert.equal(f.deps.pool.config.requestTimeout,1000,'collector never mutates caller pool');
  for(const value of [0,-1,15001,Infinity,NaN,'15000']){
    const g=fixture();g.deps.pool.config.options={requestTimeout:value};
    await assert.rejects(g.run(),/bounded requestTimeout/);
    assert.equal(g.state.begins,0);assert.equal(g.state.queries.length,0);
  }
  const nested=fixture();nested.deps.pool.config.options={requestTimeout:500};
  assert.equal((await nested.run()).request_timeout_ms,500,'nested driver option takes precedence');
});

test('wrong owner, database, server, admin or unknown guard refuses before catalogue reads',async()=>{
  for(const [key,value] of [['principal_name','website_app'],['database_name','master'],
    ['server_name','other'],['authentication_type_desc','INSTANCE'],['is_owner',1],
    ['is_security_admin',1],['database_control',1],['database_control',null]]){
    const f=fixture();f.rows.observer[0][key]=value;
    await assert.rejects(f.run(),/no current qualification/);
    assert.equal(f.state.queries.length,1);assert.equal(f.state.rollbacks,1);
  }
});

test('hidden objects and missing principal remain UNKNOWN, not absent or no rights',async()=>{
  const f=fixture();f.rows.objects.forEach(row=>row.object_id=null);
  const result=await f.run();assert.ok(result.object_presence.every(row=>row.status==='UNKNOWN'));
  assert.equal(result.website_principal,'UNKNOWN');
  assert.equal(result.effective_website_rights,'NOT_EVALUATED_AS_WEBSITE');
});

test('schema definition flag cannot prove absence where a narrower metadata DENY may apply',async()=>{
  const f=fixture();f.rows.observer[0].schema_definition=1;f.rows.objects[0].object_id=null;
  const result=await f.run();assert.equal(result.object_presence[0].status,'UNKNOWN');
  assert.equal(result.object_presence[1].status,'OBSERVED_PRESENT');
  assert.equal(result.website_principal,'UNKNOWN');
});

test('projection drops unexpected secret fields and OAuth column metadata',async()=>{
  const f=fixture({columns:[{object_name:'customers',column_name:'id',private_value:'do-not-return'},
    {object_name:'xero_connections',column_name:'access_token'},
    {object_name:'xero_connections',column_name:'REFRESH_TOKEN'}],
    permissions:[{grantee:'public',permission_name:'SELECT',state_desc:'GRANT',private_value:'do-not-return'},
      {column_name:'refresh_token'}]});
  const result=await f.run();const text=JSON.stringify(result.data);
  assert.doesNotMatch(text,/do-not-return|private_value|access_token|refresh_token/i);
  assert.equal(result.data.columns.length,1);assert.equal(result.data.permissions.length,1);
  assert.equal(result.effective_website_rights,'NOT_EVALUATED_AS_WEBSITE');
});

test('query, transaction and rollback failures never expose driver error or partial receipt',async()=>{
  await assert.rejects(readXeroCatalog({pool:{config:{requestTimeout:15000}},sql:{Transaction:class {
    constructor(){throw new Error('private-driver-details');}
  }}}),error=>error.message==='Xero catalog diagnostic unavailable; no current qualification');
  for(const name of Object.keys(QUERIES)){
    const f=fixture();f.state.failQuery=name;
    await assert.rejects(f.run(),error=>error.message==='Xero catalog diagnostic unavailable; no current qualification'
      && !error.cause);
    assert.equal(f.state.rollbacks,1);
  }
  for(const flag of ['failBegin','failRollback']){
    const f=fixture();f.state[flag]=true;await assert.rejects(f.run(),/no current qualification/);
  }
});

test('row limit, cell limit, role-depth limit and incomplete object coverage fail closed',async()=>{
  const bad=[{columns:Array.from({length:501},()=>({}))},
    {columns:[{column_name:'x'.repeat(257)}]},
    {roles:[{principal_name:'role',depth:16}]},
    {objects:[]},{principal:[{},{}]},{columns:[{column_name:{nested:'value'}}]}];
  for(const rows of bad){const f=fixture(rows);await assert.rejects(f.run(),/no current qualification/);
    assert.equal(f.state.rollbacks,1);}
});

test('aggregate receipt byte limit refuses oversized metadata even within row/cell limits',async()=>{
  const wide=Object.fromEntries(['object_name','column_id','column_name','data_type','max_length',
    'precision','scale','is_nullable','is_identity','is_computed','is_hidden','has_default']
    .map(key=>[key,'x'.repeat(256)]));
  const f=fixture({columns:Array.from({length:500},()=>({...wide}))});
  await assert.rejects(f.run(),/no current qualification/);
  assert.equal(f.state.rollbacks,1);
});
