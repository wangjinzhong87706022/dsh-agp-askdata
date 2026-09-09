import mysql from 'mysql2/promise'

const SR = { host: '192.168.101.54', port: 9030, user: 'root', password: '', database: 'WT_DB' }
const MY = { host: '192.168.101.54', port: 3306, user: 'root', password: 'Aa123456.', database: 'wisetao_meta' }

let pass = 0, fail = 0
const results = []

function check(table, expectedCols, actualCols) {
  const missing = expectedCols.filter(c => !actualCols.includes(c))
  const ok = missing.length === 0
  if (ok) { pass++ } else { fail++ }
  results.push({ table, ok, missing, actualCols, actualCount: actualCols.length, expectedCount: expectedCols.length })
  const status = ok ? '✓' : '✗'
  console.log(`  ${status} ${table}: ${actualCols.length} 列 [${actualCols.join(', ')}]${ok ? '' : `\n      缺失: ${missing.join(', ')}`}`)
}

async function validateStarRocks() {
  console.log('\n=== StarRocks WT_DB 表结构验证 ===')
  const conn = await mysql.createConnection({ ...SR, connectTimeout: 8000 })
  const tables = ['WT_TAG', 'WT_DATA', 'WT_CUBE', 'WT_DEVICE']
  for (const table of tables) {
    try {
      const [rows] = await conn.query(`DESC \`${SR.database}\`.${table}`)
      const actual = rows.map(r => r.Field)
      const expected = {
        WT_TAG: ['tagName', 'tagIndex', 'dataType', 'comment'],
        WT_DATA: ['tagIndex', 'timestamp', 'value', 'quality'],
        WT_CUBE: ['tagIndex', 'timestamp', 'value', 'quality', 'granularity'],
        WT_DEVICE: ['deviceCode', 'deviceName', 'deviceType'],
      }[table]
      check(table, expected, actual)
    } catch (e) {
      fail++
      results.push({ table, ok: false, missing: [], actualCols: [], actualCount: 0, expectedCount: 0, error: e.message })
      console.log(`  ✗ ${table}: ${e.message}`)
    }
  }
  await conn.end()
}

async function validateMySQL() {
  console.log('\n=== MySQL wisetao_meta 表结构验证 ===')
  const conn = await mysql.createConnection({ ...MY, connectTimeout: 8000 })
  const tables = ['meta_class_info', 'wt_elm_equipment', 'meta_classtagmodel', 'wt_iot_tags']
  const expected = {
    'meta_class_info': ['id', 'class_path', 'class_name', 'parent_id', 'tree_level'],
    'wt_elm_equipment': ['id', 'node_code', 'node_name', 'class__path', 'parent_id', 'tree_level', 'equipment_code', 'equipment_name'],
    'meta_classtagmodel': ['id', 'tag_code', 'name', 'tag_type', 'master_class_id', 'in_out', 'calculated', 'class__path'],
    'wt_iot_tags': ['tagName', 'tagIndex', 'alias', 'tag_code', 'master_code'],
  }
  for (const table of tables) {
    try {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [MY.database, table],
      )
      const actual = rows.map(r => r.COLUMN_NAME)
      check(table, expected[table], actual)
    } catch (e) {
      fail++
      results.push({ table, ok: false, missing: expected[table], actualCols: [], actualCount: 0, expectedCount: expected[table].length, error: e.message })
      console.log(`  ✗ ${table}: ${e.message}`)
    }
  }
  await conn.end()
}

async function sampleData() {
  console.log('\n=== 样本数据验证 ===')
  const sr = await mysql.createConnection({ ...SR, connectTimeout: 8000 })

  const [tagCnt] = await sr.query(`SELECT COUNT(*) AS c FROM \`${SR.database}\`.WT_TAG`)
  console.log(`  WT_TAG: ${tagCnt[0].c} 行`)

  const [tagSample] = await sr.query(`SELECT tagName, tagIndex, dataType, \`comment\` FROM \`${SR.database}\`.WT_TAG LIMIT 3`)
  for (const r of tagSample) console.log(`    ${JSON.stringify(r)}`)

  const [dataSample] = await sr.query(`SELECT tagIndex, \`timestamp\`, \`value\`, \`quality\` FROM \`${SR.database}\`.WT_DATA LIMIT 3`)
  console.log(`  WT_DATA: 样本 3 行`)
  for (const r of dataSample) console.log(`    ${JSON.stringify(r)}`)

  try {
    const [cubeDesc] = await sr.query(`DESC \`${SR.database}\`.WT_CUBE`)
    console.log(`  WT_CUBE 列: [${cubeDesc.map(r => r.Field).join(', ')}]`)
    const [cubeSample] = await sr.query(`SELECT * FROM \`${SR.database}\`.WT_CUBE LIMIT 3`)
    console.log(`  WT_CUBE: 样本 ${cubeSample.length} 行`)
    for (const r of cubeSample) console.log(`    ${JSON.stringify(r)}`)
  } catch (e) {
    console.log(`  WT_CUBE: 查询失败 (${e.message})`)
  }

  try {
    const [devDesc] = await sr.query(`DESC \`${SR.database}\`.WT_DEVICE`)
    console.log(`  WT_DEVICE 列: [${devDesc.map(r => r.Field).join(', ')}]`)
  } catch (e) {
    console.log(`  WT_DEVICE: 查询失败 (${e.message})`)
  }

  await sr.end()

  const my = await mysql.createConnection({ ...MY, connectTimeout: 8000 })

  for (const [table, query] of [
    ['meta_class_info', 'SELECT COUNT(*) AS c FROM meta_class_info'],
    ['wt_elm_equipment', 'SELECT COUNT(*) AS c FROM wt_elm_equipment'],
    ['meta_classtagmodel', 'SELECT COUNT(*) AS c FROM meta_classtagmodel'],
    ['wt_iot_tags', 'SELECT COUNT(*) AS c FROM wt_iot_tags'],
  ]) {
    try {
      const [cnt] = await my.query(query)
      console.log(`  ${table}: ${cnt[0].c} 行`)
    } catch (e) {
      console.log(`  ${table}: ${e.message}`)
    }
  }

  const [modelSample] = await my.query('SELECT id, class_path, class_name FROM meta_class_info LIMIT 3')
  console.log(`  meta_class_info 样本:`)
  for (const r of modelSample) console.log(`    ${JSON.stringify(r)}`)

  await my.end()
}

console.log('数据底座查询结构验证')
console.log('='.repeat(60))

await validateStarRocks()
await validateMySQL()
await sampleData()

console.log('\n' + '='.repeat(60))
console.log(`结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) {
  console.log('\n失败项:')
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.table}: ${r.missing?.length ? `缺失 ${r.missing.join(', ')}` : r.error}`)
  }
}
