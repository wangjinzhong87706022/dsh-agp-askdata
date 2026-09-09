import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: '192.168.101.54', port: 3306,
  user: process.env.MY_USER, password: process.env.MY_PWD,
})

async function listTables(db, pattern) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ORDER BY TABLE_ROWS DESC`,
    [db, pattern],
  )
  console.log(`\n== ${db}.${pattern} (${rows.length} 张)`)
  for (const r of rows)
    console.log(`  ${r.TABLE_NAME}  ~${r.TABLE_ROWS}行${r.TABLE_COMMENT ? ' // ' + r.TABLE_COMMENT : ''}`)
}

await listTables('wisetao_meta', 'wt\_elm\_%')
await listTables('wisetao_meta', 'wt\_bas\_%')
await listTables('wisetao_meta', 'meta\_%')
await listTables('wisetao_meta', 'wt\_iot\_%')
await listTables('bole', 'wt\_iot\_%')
await listTables('bole', 'wt\_cus\_%')
await listTables('bole', 'wt\_10062\_%')
await listTables('wisetao_client', 'tag\_%')
await listTables('wisetao_client', 'wt\_sys\_%')

console.log('\n=== 样本: wisetao_meta.wt_elm_equipment 前 10 行 ===')
const [eq] = await conn.query(
  'SELECT id,node_code,node_name,class__path,parent_id,tree_level,equipment_code,equipment_name,manufacturer,position FROM wisetao_meta.wt_elm_equipment WHERE deleted=0 LIMIT 10',
)
for (const r of eq) console.log(JSON.stringify(r))

console.log('\n=== 样本: wisetao_meta.meta_classtagmodel 前 10 行 ===')
const [ct] = await conn.query(
  'SELECT id,tag_code,name,tag_type,master_class_id,in_out,calculated,class__path FROM wisetao_meta.meta_classtagmodel WHERE deleted=0 LIMIT 10',
)
for (const r of ct) console.log(JSON.stringify(r))

console.log('\n=== 样本: bole.wt_cus_alarmdynamicconfig 全部 ===')
const [ac] = await conn.query(
  'SELECT id,tag_code,tag_comment,cus_class_path,alarm_type,alarm_level,status,is_white FROM bole.wt_cus_alarmdynamicconfig WHERE deleted=0 LIMIT 15',
)
for (const r of ac) console.log(JSON.stringify(r))

await conn.end()