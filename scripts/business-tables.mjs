import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: '192.168.101.54', port: 3306,
  user: process.env.MY_USER, password: process.env.MY_PWD,
})

const tables = [
  ['wisetao_meta', 'wt_elm_equipment'],
  ['wisetao_meta', 'wt_iot_tags'],
  ['wisetao_meta', 'wt_bas_alarmrecord'],
  ['wisetao_meta', 'wt_iot_equipetlconfig'],
  ['wisetao_meta', 'meta_classtagmodel'],
  ['bole', 'wt_cus_alarmdynamicconfig'],
  ['wisetao_client', 'tag_analog'],
  ['wisetao_client', 'wt_sys_asset'],
]

for (const [db, tb] of tables) {
  const [cols] = await conn.query(
    'SELECT COLUMN_NAME,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
    [db, tb],
  )
  console.log(`\n== ${db}.${tb} (${cols.length} 列)`)
  for (const c of cols)
    console.log(`  ${c.COLUMN_NAME} ${c.DATA_TYPE}${c.COLUMN_COMMENT ? ' // ' + c.COLUMN_COMMENT : ''}`)
}

await conn.end()