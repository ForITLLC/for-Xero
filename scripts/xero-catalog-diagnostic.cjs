'use strict';

// Fixed owner-side metadata collector. Deliberately no CLI, HTTP route, credential
// lookup or workflow: an allowed owner operation must supply its existing pool.
const OBJECTS = Object.freeze(['customers', 'customer_products', 'achaccounts', 'xero_connections']);
const OWNER = 'github-actions-forit-xero';
const LIMIT = 500;
const SOURCE_SHA256 = require('node:crypto').createHash('sha256')
  .update(require('node:fs').readFileSync(__filename)).digest('hex');
const targets = "(VALUES ('customers'),('customer_products'),('achaccounts'),('xero_connections'))";
const safeColumn = "NOT IN ('access_token','refresh_token')";

const QUERIES = Object.freeze({
  observer: `SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ServerName')) AS server_name,
    DB_NAME() AS database_name, USER_NAME() AS principal_name, ORIGINAL_LOGIN() AS original_login,
    p.authentication_type_desc, IS_MEMBER('db_owner') AS is_owner,
    IS_MEMBER('db_securityadmin') AS is_security_admin,
    HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL') AS database_control,
    HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION') AS database_definition,
    HAS_PERMS_BY_NAME('xero','SCHEMA','VIEW DEFINITION') AS schema_definition,
    SYSUTCDATETIME() AS observed_at
    FROM sys.database_principals p WHERE p.principal_id=USER_ID()`,
  objects: `SELECT TOP (501) n.name AS requested_name, o.object_id, o.type_desc,
    o.modify_date, USER_NAME(s.principal_id) AS schema_owner
    FROM ${targets} n(name)
    LEFT JOIN sys.schemas s ON s.name='xero'
    LEFT JOIN sys.objects o ON o.schema_id=s.schema_id AND o.name=n.name
    ORDER BY n.name`,
  columns: `SELECT TOP (501) o.name AS object_name, c.column_id, c.name AS column_name,
    t.name AS data_type, c.max_length, c.precision, c.scale, c.is_nullable,
    c.is_identity, c.is_computed, c.is_hidden,
    CASE WHEN c.default_object_id=0 THEN 0 ELSE 1 END AS has_default
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    JOIN ${targets} n(name) ON n.name=o.name
    JOIN sys.columns c ON c.object_id=o.object_id
    JOIN sys.types t ON t.user_type_id=c.user_type_id
    WHERE s.name='xero' AND c.name ${safeColumn}
    ORDER BY o.name,c.column_id`,
  constraints: `SELECT TOP (501) o.name AS object_name, i.name AS constraint_name,
    i.is_primary_key, i.is_unique, c.name AS column_name, ic.key_ordinal
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    JOIN ${targets} n(name) ON n.name=o.name
    JOIN sys.indexes i ON i.object_id=o.object_id AND i.is_unique=1
    JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
    JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
    WHERE s.name='xero' AND c.name ${safeColumn}
    ORDER BY o.name,i.index_id,ic.key_ordinal`,
  foreign_keys: `SELECT TOP (501) o.name AS object_name, f.name AS constraint_name,
    c.name AS column_name, rs.name AS referenced_schema, ro.name AS referenced_object,
    rc.name AS referenced_column, f.is_disabled, f.is_not_trusted
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    JOIN ${targets} n(name) ON n.name=o.name
    JOIN sys.foreign_keys f ON f.parent_object_id=o.object_id
    JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id
    JOIN sys.columns c ON c.object_id=fc.parent_object_id AND c.column_id=fc.parent_column_id
    JOIN sys.objects ro ON ro.object_id=fc.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id=ro.schema_id
    JOIN sys.columns rc ON rc.object_id=ro.object_id AND rc.column_id=fc.referenced_column_id
    WHERE s.name='xero' AND c.name ${safeColumn} AND rc.name ${safeColumn}
    ORDER BY o.name,f.name,fc.constraint_column_id`,
  row_policies: `SELECT TOP (501) o.name AS object_name, p.name AS policy_name,
    p.is_enabled, sp.predicate_type_desc, sp.operation_desc
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    JOIN ${targets} n(name) ON n.name=o.name
    JOIN sys.security_predicates sp ON sp.target_object_id=o.object_id
    JOIN sys.security_policies p ON p.object_id=sp.object_id
    WHERE s.name='xero' ORDER BY o.name,p.name,sp.security_predicate_id`,
  principal: `SELECT TOP (501) p.principal_id, p.name AS principal_name, p.type_desc,
    p.authentication_type_desc, p.default_schema_name, p.create_date, p.modify_date
    FROM sys.database_principals p WHERE p.name='website_app'`,
  roles: `WITH role_chain AS (
    SELECT p.principal_id, p.name AS principal_name, 0 AS depth
    FROM sys.database_principals p WHERE p.name IN ('website_app','public')
    UNION ALL
    SELECT r.principal_id,r.name,rc.depth+1 FROM role_chain rc
    JOIN sys.database_role_members m ON m.member_principal_id=rc.principal_id
    JOIN sys.database_principals r ON r.principal_id=m.role_principal_id
    WHERE rc.depth<16)
    SELECT DISTINCT TOP (501) principal_id,principal_name,depth FROM role_chain
    ORDER BY depth,principal_name OPTION (MAXRECURSION 16)`,
  permissions: `WITH role_chain AS (
    SELECT p.principal_id,0 AS depth FROM sys.database_principals p
    WHERE p.name IN ('website_app','public')
    UNION ALL
    SELECT m.role_principal_id,rc.depth+1 FROM role_chain rc
    JOIN sys.database_role_members m ON m.member_principal_id=rc.principal_id
    WHERE rc.depth<16)
    SELECT DISTINCT TOP (501) gr.name AS grantee, dp.class_desc,
    dp.permission_name, dp.state_desc, s.name AS schema_name,
    o.name AS object_name, c.name AS column_name
    FROM sys.database_permissions dp
    JOIN sys.database_principals gr ON gr.principal_id=dp.grantee_principal_id
    JOIN role_chain rc ON rc.principal_id=dp.grantee_principal_id
    LEFT JOIN sys.objects o ON dp.class=1 AND o.object_id=dp.major_id
    LEFT JOIN sys.schemas s ON s.schema_id=CASE WHEN dp.class=3 THEN dp.major_id ELSE o.schema_id END
    LEFT JOIN sys.columns c ON dp.class=1 AND c.object_id=dp.major_id AND c.column_id=dp.minor_id
    WHERE dp.class=0 OR (dp.class=3 AND s.name='xero')
      OR (dp.class=1 AND s.name='xero' AND o.name IN (SELECT name FROM ${targets} n(name))
          AND (dp.minor_id=0 OR c.name ${safeColumn}))
    ORDER BY gr.name,dp.class_desc,s.name,o.name,c.name,dp.permission_name
    OPTION (MAXRECURSION 16)`,
});

// Projection is a second boundary: extra driver fields never enter the receipt.
const FIELDS = Object.freeze({
  observer: ['server_name','database_name','principal_name','original_login','authentication_type_desc','is_owner','is_security_admin','database_control','database_definition','schema_definition','observed_at'],
  objects: ['requested_name','object_id','type_desc','modify_date','schema_owner'],
  columns: ['object_name','column_id','column_name','data_type','max_length','precision','scale','is_nullable','is_identity','is_computed','is_hidden','has_default'],
  constraints: ['object_name','constraint_name','is_primary_key','is_unique','column_name','key_ordinal'],
  foreign_keys: ['object_name','constraint_name','column_name','referenced_schema','referenced_object','referenced_column','is_disabled','is_not_trusted'],
  row_policies: ['object_name','policy_name','is_enabled','predicate_type_desc','operation_desc'],
  principal: ['principal_id','principal_name','type_desc','authentication_type_desc','default_schema_name','create_date','modify_date'],
  roles: ['principal_id','principal_name','depth'],
  permissions: ['grantee','class_desc','permission_name','state_desc','schema_name','object_name','column_name'],
});

function project(name, rows) {
  if (!Array.isArray(rows) || rows.length>LIMIT) throw new Error('Catalog result outside bounds');
  return rows.filter(row=>!['column_name','referenced_column'].some(key=>
    ['access_token','refresh_token'].includes(String(row[key]).toLowerCase())))
    .map(row => Object.fromEntries(FIELDS[name].map(key => {
    const value=row[key] ?? null;
    if (typeof value==='string' && value.length>256) throw new Error('Catalog cell outside bounds');
    if (value!==null && !(value instanceof Date) && !['string','boolean','number'].includes(typeof value)) {
      throw new Error('Catalog cell outside bounds');
    }
    return [key,value];
  })));
}

async function readXeroCatalog(deps) {
  if (!deps || Object.keys(deps).sort().join(',')!=='pool,sql' || !deps.pool || !deps.sql) {
    throw new Error('Catalog dependencies refused');
  }
  // mssql v10 reads the pool's requestTimeout; Request.timeout is unsupported.
  // Do not mutate a shared pool or silently inherit an unbounded configuration.
  const timeout=deps.pool.config?.options?.requestTimeout ?? deps.pool.config?.requestTimeout;
  if (!Number.isInteger(timeout) || timeout<1 || timeout>15000) {
    throw new Error('Catalog requires an owner pool with bounded requestTimeout');
  }
  let tx;
  let begun=false;
  try {
    tx=new deps.sql.Transaction(deps.pool);
    await tx.begin(); begun=true;
    const read=async name => {
      const request=new deps.sql.Request(tx);
      const result=await request.query(QUERIES[name]);
      return project(name,result.recordset);
    };
    const observer=await read('observer');
    const who=observer[0];
    if (observer.length!==1 || who.database_name!=='forit'
      || String(who.server_name).split('.')[0]!=='forit-saas-sql'
      || who.principal_name!==OWNER || who.authentication_type_desc!=='EXTERNAL'
      || who.is_owner!==0 || who.is_security_admin!==0 || who.database_control!==0) {
      throw new Error('Catalog observer refused');
    }
    const data={};
    for (const name of Object.keys(QUERIES).filter(name=>name!=='observer')) data[name]=await read(name);
    if (data.objects.length!==4 || new Set(data.objects.map(row=>row.requested_name)).size!==4
      || data.objects.some(row=>!OBJECTS.includes(row.requested_name)) || data.principal.length>1
      || data.roles.some(row=>row.depth>=16)) throw new Error('Catalog coverage outside bounds');
    await tx.rollback(); begun=false;
    const receipt = {
      schema_version:1, source_sha256:SOURCE_SHA256, request_timeout_ms:timeout, observer:who, data,
      object_presence:data.objects.map(row=>({name:`xero.${row.requested_name}`,
        status:row.object_id!==null ? 'OBSERVED_PRESENT' : 'UNKNOWN'})),
      website_principal:data.principal.length===1 ? 'OBSERVED_PRESENT' : 'UNKNOWN',
      permissions_basis:'VISIBLE_CATALOG_ONLY', effective_website_rights:'NOT_EVALUATED_AS_WEBSITE',
      limits:['Catalog visibility can hide grants, roles and objects; empty is not proof of no rights.',
        'Database/schema definition flags do not establish absence where narrower DENY can hide metadata.',
        'Fixed-role, ownership, server-level and impersonation effects are not evaluated.',
        'OAuth columns, values and predicate/default/computed definitions are excluded.'],
      transaction:'ROLLED_BACK', row_data_read:false, access_changed:false,
    };
    if (Buffer.byteLength(JSON.stringify(receipt),'utf8')>512*1024) {
      throw new Error('Catalog receipt outside bounds');
    }
    return receipt;
  } catch {
    if (begun) await tx.rollback().catch(()=>{});
    // Do not propagate driver errors, which can contain connection details.
    throw new Error('Xero catalog diagnostic unavailable; no current qualification');
  }
}

module.exports={readXeroCatalog,QUERIES,OBJECTS};
