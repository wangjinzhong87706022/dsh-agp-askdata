// P1 端到端验证：真实 MySQL 元数据库 + StarRocks 上跑 P1 六工具。
// 用法：npx tsx scripts/e2e-p1.ts（可用环境变量覆盖 SR_*/MY_* 凭据；MY_PASSWORD 必填）
// 验收覆盖 §14.9 验证计划的真实可跑场景：
//   "有哪些光伏设备模型" / "1号箱变下有哪些逆变器" / "华为逆变器有哪些测点"
//   "1号箱变1号逆变器总发电量最新值" / "最近有什么告警" / "AGC设备的告警配置"
import { createAskdataService } from '../src/index.ts'
import type { ToolResult } from '../src/result.ts'

const service = createAskdataService({
  connection: {
    host: process.env.SR_HOST ?? '192.168.101.54',
    port: Number(process.env.SR_PORT ?? 9030),
    user: process.env.SR_USER ?? 'root',
    password: process.env.SR_PASSWORD ?? '',
    database: process.env.SR_DATABASE ?? 'WT_DB',
  },
  mysqlConnection: {
    host: process.env.MY_HOST ?? '192.168.101.54',
    port: Number(process.env.MY_PORT ?? 3306),
    user: process.env.MY_USER ?? 'root',
    password: process.env.MY_PASSWORD ?? '',
    database: process.env.MY_DATABASE ?? 'wisetao_meta',
  },
  appId: Number(process.env.APP_ID ?? 10062),
  system: { queryTimeoutMs: Number(process.env.SR_TIMEOUT ?? 30_000) },
})
const ctx = service.createContext()
const tool = (name: string) => {
  const t = service.tools.find((t) => t.name === name)
  if (!t) throw new Error(`工具未注册: ${name}`)
  return t
}

function brief(tag: string, r: ToolResult): void {
  const status = r.success ? '✓' : '✗'
  console.log(
    `\n${status} [${tag}] ${r.executionMs}ms rows=${r.rowCount} errorCode=${r.errorCode || '-'}`,
  )
  if (!r.success) console.log(`  错误: ${r.errorMessage.slice(0, 240)}`)
  for (const row of r.data.slice(0, 3)) console.log('  ·', JSON.stringify(row))
  if (r.rowCount > 3) console.log(`  ... 共 ${r.rowCount} 行`)
}

// 1. lookup_model：app_id=10062 的所有光伏模型清单（§14.9 场景）
brief('lookup_model', await tool('lookup_model').run({}, ctx))

// 2. lookup_object：找 1号箱变（父设备）—— §14.9 "1号箱变下有哪些逆变器"
const padMount = await tool('lookup_object').run({ node_name: '1号箱变1号逆变器' }, ctx)
brief('lookup_object (1号箱变1号逆变器)', padMount)
const padMountId = padMount.data[0]?.['id']

// 3. lookup_tag_definition：华为逆变器测点定义（§14.9 场景）—— 真实路径
const huaweiPath = padMount.data[0]?.['class__path'] ?? 'wt_elm_equipment/wt_iot_huaweisun2000'
brief('lookup_tag_definition (华为逆变器)', await tool('lookup_tag_definition').run({ class_path: huaweiPath }, ctx))

// 4. resolve_tag：1号箱变1号逆变器 + 真实测点"总发电量" + 1D 粒度
const resolved = await tool('resolve_tag').run(
  { device_name: '1号箱变1号逆变器', tag_name_cn: '总发电量', granularity: '1D' },
  ctx,
)
brief('resolve_tag (总发电量 1D)', resolved)
const resolvedTagName = resolved.data[0]?.tagName

// 5. latest_value：验证 resolve_tag 解析出的 tagName 在 TSDB 上有数据（兜底路 max_by）
if (resolvedTagName) {
  brief('latest_value (解析出的 tagName)', await tool('latest_value').run({ tag_names: [resolvedTagName] }, ctx))
  // 6. aggregate：1D 粒度 → 自动路由 WT_CUBE
  brief(
    'aggregate (1D cube 路由)',
    await tool('aggregate').run({
      tag_filter: `^${resolvedTagName}`,
      start_time: '2024-08-01',
      end_time: '2024-08-14',
      func: 'AVG',
    }, ctx),
  )
}

// 7. query_alarm：最近告警记录（真实表 alarmrecord 时间范围 2024-06-16 ~ 2024-10-10）
brief(
  'query_alarm (最近告警)',
  await tool('query_alarm').run(
    { start_time: '2024-06-16', end_time: '2024-10-10', limit: 5 },
    ctx,
  ),
)

// 8. query_alarm_config：AGC 类（真实表 379 行配置；AGC 子类无独立配置属正常）
brief(
  'query_alarm_config (AGC)',
  await tool('query_alarm_config').run(
    { cus_class_path: 'wt_elm_equipment/wt_iot_agc_adb3be1a' },
    ctx,
  ),
)
brief(
  'query_alarm_config (无过滤全量)',
  await tool('query_alarm_config').run({}, ctx),
)

console.log('\nP1 端到端验证完成')
