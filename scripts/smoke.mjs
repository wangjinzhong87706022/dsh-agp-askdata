// StarRocks 连接冒烟脚本（P0 手工验证用，不进测试链）
// 用法：node scripts/smoke.mjs  或用环境变量覆盖 SR_HOST/SR_PORT/SR_USER/SR_PASSWORD/SR_DATABASE
import mysql from 'mysql2/promise'

const host = process.env.SR_HOST ?? '192.168.101.54'
const port = Number(process.env.SR_PORT ?? 9030)
const user = process.env.SR_USER ?? 'root'
const password = process.env.SR_PASSWORD ?? ''
const database = process.env.SR_DATABASE ?? 'information_schema'

console.log(`连接 ${user}@${host}:${port}/${database} ...`)
try {
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    connectTimeout: 8000,
    dateStrings: true,
  })
  console.log('✓ 连接成功')

  try {
    const [verRows] = await conn.query('SELECT current_version() AS version')
    console.log('✓ StarRocks 版本:', verRows[0]?.version)
  } catch {
    console.log('（current_version() 不可用，跳过版本探测）')
  }

  const [dbs] = await conn.query('SHOW DATABASES')
  const dbNames = dbs.map((r) => Object.values(r)[0])
  console.log('✓ 数据库列表:', dbNames.join(', '))

  const [tables] = await conn.query(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE UPPER(table_name) IN ('WT_TAG', 'WT_DATA', 'WT_QUERY_AUDIT')`,
  )
  if (tables.length === 0) {
    console.log('⚠ 未发现 WT_TAG / WT_DATA / WT_QUERY_AUDIT 表（问数工具需要这些表）')
  } else {
    console.log('✓ 关键表:')
    for (const t of tables) console.log(`   - ${t.table_schema}.${t.table_name}`)
  }

  await conn.end()
  console.log('✓ 冒烟通过')
} catch (err) {
  const e = err
  console.error('✗ 连接失败:', e.code ?? '', e.message)
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH') {
    console.error(`  提示：${host}:${port} 不可达。确认 FE 查询端口（默认 9030，连接 MySQL 协议端口而非 http_port 8030）。`)
  } else if (e.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('  提示：认证失败。确认 root 空密码，或 StarRocks 账号认证插件（建议 mysql_native_password）。')
  } else if (e.code === 'ER_BAD_DB_ERROR') {
    console.error('  提示：库名不存在，改用 SR_DATABASE 指定已有库。')
  }
  process.exit(1)
}
