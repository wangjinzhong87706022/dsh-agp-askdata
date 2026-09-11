/**
 * API 工具面测试：单次执行语义（plan 的 request 与 describe 用同一次响应，
 * 管线绝不重放第二次请求）、显式 GET/POST 路由、describe 类型化与分页透传、
 * 入参校验、错误码映射与审计落行。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { AskdataConfig } from '../src/config.ts'
import { ApiClient } from '../src/api/client.ts'
import { AskdataError, askdataError } from '../src/errors.ts'
import type { AuditRow } from '../src/audit.ts'
import { apiTools } from '../tools-api/index.ts'
import type { ApiExecutor, ApiToolContext } from '../tools-api/types.ts'

interface RecordedCall {
  method: 'GET' | 'POST'
  path: string
  params: Record<string, unknown>
}

function testContext(
  respond: (call: RecordedCall) => unknown,
): { ctx: ApiToolContext; calls: RecordedCall[]; audits: AuditRow[] } {
  const config: AskdataConfig = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
    audit: { enabled: true },
  })
  const calls: RecordedCall[] = []
  const executor: ApiExecutor = {
    async execute(method, path, params) {
      const call: RecordedCall = { method, path, params }
      calls.push(call)
      return respond(call)
    },
  }
  const audits: AuditRow[] = []
  const ctx: ApiToolContext = {
    config,
    apiClient: executor,
    prevAuditHash: '',
    onAudit: (row) => audits.push(row as AuditRow),
  }
  return { ctx, calls, audits }
}

const tool = (name: string) => {
  const t = apiTools.find((t) => t.name === name)
  if (!t) throw new Error(`API 工具未注册: ${name}`)
  return t
}

/** QueryResult 形态的假响应。 */
const queryResult = (overrides?: Partial<{ field: unknown[]; data: unknown[]; page: unknown }>) => ({
  field: overrides?.field ?? [
    { name: 'time', title: '时间', type: '52' },
    { name: 'value', title: '值', type: '1' },
    { name: 'name', title: '名称', type: '4' },
  ],
  data: overrides?.data ?? [{ time: '2024-08-14 10:00:00', value: '12.5', name: 'x' }],
  page: overrides?.page ?? { pageNum: 1, pageSize: 100, pageTotal: 3, itemTotal: 205 },
})

describe('单次执行语义（管线不重放第二次请求）', () => {
  it('全部 10 个工具各恰好发起一次 HTTP 调用', async () => {
    const respond = (call: RecordedCall): unknown => {
      if (call.path.includes('getModelList')) return { field: [], data: [{ id: 1 }] }
      if (call.path.includes('getIOTTagRealValues')) return { field: [], data: [{ value: 1, time: 't', tagName: 'A' }] }
      if (call.path.includes('getModelBasAttributes')) return { field: [{ name: 'f', type: '4' }] }
      return queryResult()
    }
    for (const t of apiTools) {
      const args: Record<string, unknown> = {
        list_models: {},
        model_attributes: { model_name: 'm' },
        query_model: { model_name: 'm' },
        query_model_segment: {
          model_name: 'm',
          search_str: '姓名,count(*) as 计数',
          segment: [{ where_str: '年龄 > 20', title: '青年' }],
        },
        query_relation_segment: {
          relation_name: '组织和用户的关系',
          search_str: '组织名称,count(*) as 计数',
          segment: [{ where_str: '年龄 > 20', title: '青年' }],
        },
        resolve_tag: { keyword: '水位' },
        tag_real: { tag_names: ['A_1O_D1'] },
        tag_history: { tag_names: ['A_1O_D1'], start_time: '2024-08-14 00:00:00', end_time: '2024-08-15 00:00:00' },
        tag_wide: { tag_names: ['A_1O_D1'], start_time: '2024-08-14 00:00:00', interval: 60 },
        tag_aggregate: { tag_names: ['A_1O_D1'], start_time: '2024-08-14 00:00:00', end_time: '2024-08-15 00:00:00', methods: ['max', 'min'] },
      }[t.name] ?? {}
      const { ctx, calls } = testContext(respond)
      const result = await t.run(args, ctx)
      expect(result.success, `${t.name} 应成功: ${result.errorMessage}`).toBe(true)
      expect(calls, `${t.name} 应恰好一次 HTTP 调用`).toHaveLength(1)
    }
  })
})

describe('请求路由与参数组装', () => {
  it('query_model：POST body 携带 where/orderBy/pageSize（过滤条件不得在管线中丢失）', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    const result = await tool('query_model').run(
      { model_name: 'staff', search_str: '*', where_str: '年龄 > 30', order_by_str: '年龄 DESC', page_size: 50, page_num: 2 },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/wz/meta/postModelDataMeta',
      params: {
        modelName: 'staff',
        whereStr: '年龄 > 30',
        orderByStr: '年龄 DESC',
        pageSize: 50,
        pageNum: 2,
      },
    })
  })
  it('query_model：page_size 超上限被钳制，非法分页参数被拒', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    await tool('query_model').run({ model_name: 'm', page_size: 5000 }, ctx)
    expect(calls[0]!.params.pageSize).toBe(1000)
    const bad = await tool('query_model').run({ model_name: 'm', page_size: 'abc' }, ctx)
    expect(bad.errorCode).toBe('INVALID_PARAM')
  })
  it('resolve_tag：whereStr 由 keyword 构造；含单引号的 keyword 被拒', async () => {
    const { ctx, calls } = testContext(() => ({
      field: [
        { name: 'tagname', title: '测点名', type: '4' },
        { name: 'alias', title: '别名', type: '4' },
        { name: 'description', title: '描述', type: '4' },
      ],
      data: [{ tagname: 'A_1O_D1', alias: '水位', description: 'd' }],
    }))
    const result = await tool('resolve_tag').run({ keyword: '水位' }, ctx)
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/wz/meta/postModelDataMeta' })
    expect(calls[0]!.params.whereStr).toBe("tagname LIKE '%水位%' OR alias LIKE '%水位%'")
    expect(result.data[0]).toEqual({ tagName: 'A_1O_D1', alias: '水位', description: 'd' })

    const quoted = await tool('resolve_tag').run({ keyword: "a'b" }, testContext(() => queryResult()).ctx)
    expect(quoted.errorCode).toBe('INVALID_PARAM')
  })
  it('tag_real：20260910 新接口 QueryResult 形态（行键与 field 名不一致，双键名兼容）', async () => {
    const { ctx, calls } = testContext(() => ({
      field: [
        { name: 'tagname', title: '测点代码', type: '3' },
        { name: 'datetime', title: '时间戳', type: '51' },
        { name: 'value', title: '数值', type: '22' },
        { name: 'quality', title: '数据质量', type: '11' },
      ],
      data: [
        { value: 20.07, time: '2026-09-10 18:56:00', tagName: 'current_1O_pump0002', comment: '第二台水泵电流' },
      ],
    }))
    const result = await tool('tag_real').run({ tag_names: ['current_1O_pump0002'] }, ctx)
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/wz/iot-etl/iot/getIOTTagRealValues',
      params: { tagNames: ['current_1O_pump0002'] },
    })
    expect(result.fields.map((f) => f.type)).toEqual(['string', 'number', 'datetime', 'string'])
    expect(result.data[0]).toEqual({
      tagName: 'current_1O_pump0002',
      value: 20.07,
      timestamp: '2026-09-10 18:56:00',
      comment: '第二台水泵电流',
    })
  })
  it('tag_real：旧 getTagRealValues 对象映射形态回落兼容', async () => {
    const { ctx } = testContext(() => ({
      A_1O_D1: { value: '12.5', time: '2024-08-14 10:00:00', tagName: 'A_1O_D1' },
      B_1O_D2: {},
    }))
    const result = await tool('tag_real').run({ tag_names: ['A_1O_D1', 'B_1O_D2'] }, ctx)
    expect(result.success).toBe(true)
    expect(result.data).toEqual([
      { tagName: 'A_1O_D1', value: 12.5, timestamp: '2024-08-14 10:00:00', comment: null },
      { tagName: 'B_1O_D2', value: null, timestamp: null, comment: null },
    ])
  })
  it('query_model_segment：POST body 携带 segment 分段定义', async () => {
    const { ctx, calls } = testContext(() => queryResult({
      field: [
        { name: '分段', title: '分段', type: '3' },
        { name: '计数', title: '计数', type: '11' },
      ],
      data: [
        { 分段: '大于20小于40岁', 计数: 12 },
        { 分段: '40到60之间', 计数: 34 },
      ],
    }))
    const result = await tool('query_model_segment').run(
      {
        model_name: '职工基础模型',
        search_str: '姓名,count(*) as 计数',
        segment: [
          { where_str: '年龄 > 20 and 年龄 < 40', title: '大于20小于40岁' },
          { where_str: '年龄 >= 40 and 年龄 < 60', title: '40到60之间' },
        ],
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/wz/meta/postModelAggrigateData',
      params: {
        modelName: '职工基础模型',
        searchStr: '姓名,count(*) as 计数',
        segment: [
          { whereStr: '年龄 > 20 and 年龄 < 40', title: '大于20小于40岁' },
          { whereStr: '年龄 >= 40 and 年龄 < 60', title: '40到60之间' },
        ],
      },
    })
    expect(result.data[0]).toEqual({ 分段: '大于20小于40岁', 计数: 12 })
  })
  it('query_model_segment：segment 缺失或空 → INVALID_PARAM 且不触达执行器', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    expect((await tool('query_model_segment').run({ model_name: 'm', search_str: 'x' }, ctx)).errorCode).toBe('INVALID_PARAM')
    expect((await tool('query_model_segment').run({ model_name: 'm', search_str: 'x', segment: [{ title: '无条件' }] }, ctx)).errorCode).toBe('INVALID_PARAM')
    expect(calls).toHaveLength(0)
  })
  it('query_relation_segment：POST body 携带 relationName 与左右模型', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    const result = await tool('query_relation_segment').run(
      {
        relation_name: '组织和用户的关系',
        search_str: '组织名称,count(*) as 计数',
        right_model_name: '职工基础模型',
        segment: [{ where_str: '年龄 > 20' }],
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/wz/meta/postRelationAggrigateData',
      params: {
        relationName: '组织和用户的关系',
        leftModelName: '',
        rightModelName: '职工基础模型',
      },
    })
    // 无 title 的段自动命名
    expect((calls[0]!.params.segment as Array<{ title: string }>)[0]!.title).toBe('段1')
  })
  it('tag_aggregate：路径为网关官方拼写 Aggrigate，params 恒传（空串占位），可选参数透传', async () => {
    const { ctx, calls } = testContext(() => ({
      type: 'history_inter',
      data: {
        current_1O_pump0001: [
          { tag: 'current_1O_pump0001', type: 'ANALOG', time: '2026-09-09 00:00:00', value: '5.5', comment: '第一台水泵电流' },
        ],
      },
    }))
    const result = await tool('tag_aggregate').run(
      { tag_names: ['A_1O_D1'], start_time: '2024-08-14 00:00:00', methods: ['max', 'mean'], sample: 10, params: 'p=50' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/wz/iot-etl/iot/getTagAggrigateHistory',
      params: { tagNames: ['A_1O_D1'], methods: ['max', 'mean'], sample: 10, params: 'p=50' },
    })
    // history_inter 包装形态：行扁平化并回填 tagName
    expect(result.data[0]).toMatchObject({ tagName: 'current_1O_pump0001', value: 5.5 })
  })
  it('tag_aggregate：end_time 与 sample 均缺省 → INVALID_PARAM（网关要求参数全传）', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    const result = await tool('tag_aggregate').run(
      { tag_names: ['A'], start_time: '2024-08-14 00:00:00', methods: ['max'] },
      ctx,
    )
    expect(result.errorCode).toBe('INVALID_PARAM')
    expect(calls).toHaveLength(0)
  })
  it('tag_history / tag_wide：end_time 与 sample 互斥透传', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    await tool('tag_history').run(
      { tag_names: ['A'], start_time: '2024-08-14 00:00:00', end_time: '2024-08-15 00:00:00' },
      ctx,
    )
    expect(calls[0]!.params).toMatchObject({ endTime: '2024-08-15 00:00:00' })
    expect(calls[0]!.params).not.toHaveProperty('sample')
    await tool('tag_wide').run(
      { tag_names: ['A'], start_time: '2024-08-14 00:00:00', interval: 60, sample: 5 },
      ctx,
    )
    expect(calls[1]!.params).toMatchObject({ interval: 60, sample: 5 })
  })
})

describe('describe 类型化与分页', () => {
  it('field 类型码映射（52→datetime / 1→number / 其余 string），page 透传进 ToolResult', async () => {
    const { ctx } = testContext(() => queryResult())
    const result = await tool('tag_history').run(
      { tag_names: ['A'], start_time: '2024-08-14 00:00:00' },
      ctx,
    )
    expect(result.fields).toEqual([
      { name: 'time', title: '时间', type: 'datetime' },
      { name: 'value', title: '值', type: 'number' },
      { name: 'name', title: '名称', type: 'string' },
    ])
    expect(result.data[0]).toEqual({ time: '2024-08-14 10:00:00', value: 12.5, name: 'x' })
    expect(result.page).toEqual({ pageNum: 1, pageSize: 100, pageTotal: 3, itemTotal: 205 })
  })
  it('list_models 解包 {field, data} 包装；id 数值化', async () => {
    const { ctx } = testContext(() => ({
      field: [],
      data: [{ id: '7', class_alias: '逆变器', class_name: 'wt_iot_huaweisun2000', class_path: 'wt_elm_equipment/wt_iot_huaweisun2000' }],
    }))
    const result = await tool('list_models').run({}, ctx)
    expect(result.data[0]).toMatchObject({ id: 7, class_alias: '逆变器' })
  })
  it('model_attributes 兼容 {field} 包装与数组直出两种响应', async () => {
    const wrapped = testContext(() => ({ field: [{ field_name: 'age', field_description: '年龄', field_type: 'int' }] }))
    const r1 = await tool('model_attributes').run({ model_name: 'staff' }, wrapped.ctx)
    expect(r1.data[0]).toEqual({ field_name: 'age', field_description: '年龄', field_type: 'int' })
    expect(wrapped.calls[0]).toMatchObject({
      method: 'GET',
      path: '/wz/meta/getModelBasAttributes',
      params: { modelName: 'staff' },
    })
    const bare = testContext(() => [{ field_name: 'name', field_description: '姓名', field_type: 'varchar' }])
    const r2 = await tool('model_attributes').run({ model_name: 'staff' }, bare.ctx)
    expect(r2.data[0]).toMatchObject({ field_name: 'name' })
  })
})

describe('入参校验与错误映射', () => {
  it('tag_names 缺省/空数组/空串 → INVALID_PARAM 且不触达执行器', async () => {
    const { ctx, calls } = testContext(() => queryResult())
    expect((await tool('tag_real').run({}, ctx)).errorCode).toBe('INVALID_PARAM')
    expect((await tool('tag_real').run({ tag_names: [] }, ctx)).errorCode).toBe('INVALID_PARAM')
    expect((await tool('tag_real').run({ tag_names: [' '] }, ctx)).errorCode).toBe('INVALID_PARAM')
    expect(calls).toHaveLength(0)
  })
  it('tag_wide 的 interval 必须为正整数', async () => {
    const { ctx } = testContext(() => queryResult())
    expect((await tool('tag_wide').run({ tag_names: ['A'], start_time: 't', interval: 0 }, ctx)).errorCode).toBe('INVALID_PARAM')
  })
  it('tag_aggregate 未知统计方法 → INVALID_PARAM', async () => {
    const { ctx } = testContext(() => queryResult())
    const result = await tool('tag_aggregate').run(
      { tag_names: ['A'], start_time: 't', methods: ['median'] },
      ctx,
    )
    expect(result.errorCode).toBe('INVALID_PARAM')
    expect(result.errorMessage).toContain('median')
  })
  it('AskdataError 保留规范错误码；未知异常收敛为 BACKEND_DOWN', async () => {
    const failing = testContext(() => {
      throw askdataError('API_TIMEOUT', '超时')
    })
    const r1 = await tool('tag_real').run({ tag_names: ['A'] }, failing.ctx)
    expect(r1.errorCode).toBe('API_TIMEOUT')
    const unknown = testContext(() => {
      throw new Error('socket hang up')
    })
    const r2 = await tool('tag_real').run({ tag_names: ['A'] }, unknown.ctx)
    expect(r2.errorCode).toBe('BACKEND_DOWN')
    expect(r2.errorMessage).not.toContain('at ')
  })
})

describe('ApiClient GET 序列化', () => {
  it('数组参数逗号连接、标量 String 化；URL 与鉴权头（含网关必需的 WT-ROUTER）正确组装', async () => {
    const captured: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      captured.push({ url: String(url), headers: init?.headers ?? {} })
      return new Response(JSON.stringify({ code: 0, message: '', data: {}, timestamp: 0, executeTime: 0 }), { status: 200 })
    })
    try {
      const client = new ApiClient({
        baseUrl: 'https://api.example.com',
        apiPrefix: '/s1M6_uE9',
        token: 'tok',
        openid: 'oid',
        projectId: 'pid',
        timeoutMs: 5000,
        maxPageSize: 100,
      })
      await client.execute('GET', '/wz/iot-etl/iot/getTagRealValues', {
        tagNames: ['a_1O_1', 'b_1O_2'],
        n: 5,
      })
      expect(captured[0]!.url).toBe(
        'https://api.example.com/s1M6_uE9/wz/iot-etl/iot/getTagRealValues?tagNames=a_1O_1%2Cb_1O_2&n=5',
      )
      expect(captured[0]!.headers).toMatchObject({
        'WT-TOKEN': 'tok',
        'WT-OPENID': 'oid',
        'WT-APPID': 'pid',
        'WT-PROJECTID': 'pid',
        'WT-ROUTER': '#/',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('审计', () => {
  it('审计行携带 apiOrSql 与工具名，auditId 回填', async () => {
    const { ctx, audits } = testContext(() => ({ A: { value: '1' } }))
    const result = await tool('tag_real').run({ tag_names: ['A'] }, ctx)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.sqlText).toBe('GET API /wz/iot-etl/iot/getIOTTagRealValues')
    expect(audits[0]!.toolName).toBe('tag_real')
    expect(result.auditId).toBe(audits[0]!.auditId)
  })
  it('失败调用同样落审计行（错误码记录）', async () => {
    const { ctx, audits } = testContext(() => {
      throw new AskdataError('API_UNREACHABLE', '不可达')
    })
    await tool('tag_real').run({ tag_names: ['A'] }, ctx)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.errorCode).toBe('API_UNREACHABLE')
  })
})
