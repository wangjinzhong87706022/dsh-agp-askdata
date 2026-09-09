import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: '192.168.101.54',
  port: 3306,
  user: process.env.MY_USER,
  password: process.env.MY_PWD,
  connectTimeout: 8000,
})

const [v] = await conn.query('SELECT VERSION() AS v, @@hostname AS h, @@port AS p')
console.log('实例:', JSON.stringify(v[0]))

const [dbs] = await conn.query('SHOW DATABASES')
const skip = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])
const names = dbs.map((d) => d.Database).filter((n) => !skip.has(n))
console.log(`\n业务库 ${names.length} 个:`, names.join(', '))

for (const db of names) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME, TABLE_ROWS, ENGINE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_ROWS DESC LIMIT 30`,
    [db],
  )
  const [cnt] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [db],
  )
  console.log(`\n== 库 ${db}（共 ${cnt[0].c} 张表，按行数降序前 30）`)
  for (const t of tables) {
    const cmt = t.TABLE_COMMENT ? `  // ${t.TABLE_COMMENT}` : ''
    console.log(`   ${t.TABLE_NAME}  ~${t.TABLE_ROWS} 行  [${t.ENGINE}]${cmt}`)
  }
}

await conn.end()