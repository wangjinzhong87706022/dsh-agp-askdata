/**
 * DSH 配置页测试：schema 默认值可装配、JSON 映射字段解析、页面元数据（角色/描述）。
 * @module
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, toRuntimeConfig, parseJsonMapField, installPreset } from '../src/dsh/plugin.ts'
import { createAskdataService } from '../src/index.ts'
import { DEFAULT_CUBE_TYPE_MAP } from '../src/config.ts'

/** 物化 schema 默认值（loader 对 cordis.yml 配置块做的事；host/database 必填需提供）。 */
function defaultConfig(): ReturnType<typeof Config> {
  return Config({ connection: { host: 'fe.example.com', database: 'WT_DB' } }) as ReturnType<typeof Config>
}

describe('配置页默认值可装配', () => {
  it('schema 默认值经 toRuntimeConfig → createAskdataService 全程通过', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    // P0 五 + P1 六 + subagent 一 + 知识面四 + 值班报告二 + meta 六 = 24
    expect(service.tools).toHaveLength(24)
    expect(service.config.query.aggregateTable).toBe('WT_CUBE')
    expect(service.config.query.cubeTypeMap[7]).toBe(DEFAULT_CUBE_TYPE_MAP[7])
    expect(service.config.query.granularityMap['1D']).toBe(2)
  })

  it('知识面默认不装配（datasetIds 空），取数面不受影响', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    expect(service.config.knowledge.datasetIds).toEqual([])
    expect(service.tools.map((t) => t.name)).toContain('knowledge_search')
    const ctx = service.createContext()
    expect(ctx.knowledge).toBeUndefined()
  })

  it('配置 datasetIds 后知识面客户端装配进 ToolContext', () => {
    const service = createAskdataService({
      connection: { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'WT_DB' },
      knowledge: { datasetIds: ['fda7a510a87c11f1998b3dc126099a8d'] },
    })
    expect(service.config.knowledge.datasetIds).toHaveLength(1)
    expect(service.createContext().knowledge).toBeDefined()
  })

  it('值班报告面：duty 台账经 schema → toRuntimeConfig 全程通过，空台账为合法部署', () => {
    const base = defaultConfig()
    // 空台账（schema 默认）合法：值班工具调用期提示，不影响装配
    expect(base.duty.stations).toEqual([])

    // 演示台账（cordis.patch.yml 同构）经 schema 物化后可装配
    const configured = Config({
      connection: { host: 'fe.example.com', database: 'WT_DB' },
      duty: {
        project: '桃曲坡水库',
        outputDir: '',
        stations: [{
          id: 'TQP-DAM-SW',
          name: '桃曲坡水库坝上水位站',
          metrics: [{
            metric: 'water_level', label: '坝上水位', unit: 'm', tagName: 'TQPSW001_1O_1', decimals: 2,
            thresholds: [{ level: '汛限', value: 786.8 }],
          }],
        }],
        reporting: [{ object: '市防指', channel: '专报', frequency: '每 2 小时' }],
      },
    }) as ReturnType<typeof Config>
    const service = createAskdataService(toRuntimeConfig(configured))
    expect(service.config.duty.project).toBe('桃曲坡水库')
    expect(service.config.duty.stations[0]!.metrics[0]!.thresholds![0]!.value).toBe(786.8)
    expect(service.tools.map((t) => t.name)).toContain('generate_duty_report')
  })

  it('值班报告面配置校验：非法测站 id / 重复指标键 / 空 metrics 加载期报错', () => {
    const conn = { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'WT_DB' }
    expect(() => createAskdataService({
      connection: conn,
      duty: { stations: [{ id: 'bad id!', name: 'x', metrics: [{ metric: 'm', label: 'l', unit: 'u', tagName: 'T' }] }] },
    })).toThrow(/stations\[\]\.id/)
    expect(() => createAskdataService({
      connection: conn,
      duty: {
        stations: [{
          id: 'S', name: 'x', metrics: [
            { metric: 'm', label: 'l', unit: 'u', tagName: 'T1' },
            { metric: 'm', label: 'l2', unit: 'u', tagName: 'T2' },
          ],
        }],
      },
    })).toThrow(/指标键重复/)
    expect(() => createAskdataService({
      connection: conn,
      duty: { stations: [{ id: 'S', name: 'x', metrics: [] }] },
    })).toThrow(/metrics 不能为空/)
  })

  it('知识面配置校验：非法基址 / 非法数据集 id 加载期报错', () => {
    const conn = { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'WT_DB' }
    expect(() => createAskdataService({
      connection: conn,
      knowledge: { ragflowBaseUrl: 'ftp://nope' },
    })).toThrow(/ragflowBaseUrl/)
    expect(() => createAskdataService({
      connection: conn,
      knowledge: { datasetIds: ['has spaces'] },
    })).toThrow(/datasetIds/)
  })

  it('默认值里的连接留空（不烙印内网拓扑），host/database 必填由 schema 强制', () => {
    const cfg = defaultConfig()
    expect(cfg.mysqlConnection.host).toBe('')
    expect(cfg.connection.user).toBe('askdata_ro')
    expect(() => Config(null)).toThrow()
  })

  it('meta 面阈值与预览缺省行数随配置下发，缺省值与文档一致', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    expect(service.config.query.meta).toEqual({ relationCap: 300, defaultPageSize: 100, fieldCap: 300 })
    expect(service.config.system.defaultPreviewLimit).toBe(20)
  })

  it('meta 面阈值可被部署配置覆盖（部分覆盖时其余取默认）', () => {
    const cfg = defaultConfig()
    cfg.query.meta = { ...cfg.query.meta, relationCap: 50 }
    const service = createAskdataService(toRuntimeConfig(cfg))
    expect(service.config.query.meta).toEqual({ relationCap: 50, defaultPageSize: 100, fieldCap: 300 })
  })

  it('阈值加载期校验：maxPageSize / meta 阈值 / 预览缺省必须是 ≥1 整数', () => {
    const conn = { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'WT_DB' }
    const rest = { baseUrl: '', wtAppid: '', wtOpenid: '', wtToken: '', fallbackToSql: true, maxPageSize: 1000 }
    expect(() => createAskdataService({ connection: conn, query: { rest: { ...rest, maxPageSize: 0 } } }))
      .toThrow(/query\.rest\.maxPageSize 必须是 ≥1 的整数/)
    expect(() => createAskdataService({ connection: conn, query: { rest: { ...rest, maxPageSize: 1.5 } } }))
      .toThrow(/query\.rest\.maxPageSize/)
    expect(() => createAskdataService({ connection: conn, query: { meta: { relationCap: 0 } } }))
      .toThrow(/query\.meta\.relationCap/)
    expect(() => createAskdataService({ connection: conn, query: { meta: { defaultPageSize: -1 } } }))
      .toThrow(/query\.meta\.defaultPageSize/)
    expect(() => createAskdataService({ connection: conn, query: { meta: { fieldCap: 0 } } }))
      .toThrow(/query\.meta\.fieldCap/)
    expect(() => createAskdataService({ connection: conn, system: { defaultPreviewLimit: 0 } }))
      .toThrow(/system\.defaultPreviewLimit/)
  })

  it('审计哈希链默认开启（进程内行构建；落库为 P2）', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    expect(service.config.audit.enabled).toBe(true)
  })
})

describe('parseJsonMapField（页面 textarea ↔ 运行时 Record）', () => {
  it('JSON 字符串解析为对象', () => {
    expect(parseJsonMapField('f', '{"1H":1,"1D":2}')).toEqual({ '1H': 1, '1D': 2 })
  })
  it('对象直传（cordis.yml 部署默认值形态）', () => {
    expect(parseJsonMapField('f', { 1: 'x' })).toEqual({ 1: 'x' })
  })
  it('空串/空值 → 空对象（不做该路由）', () => {
    expect(parseJsonMapField('f', '')).toEqual({})
    expect(parseJsonMapField('f', undefined)).toEqual({})
    expect(parseJsonMapField('f', null)).toEqual({})
  })
  it('坏 JSON / 数组 / 标量 → 加载期报错并带字段名', () => {
    expect(() => parseJsonMapField('query.cubeTypeMapJson', '{oops')).toThrow(/query\.cubeTypeMapJson/)
    expect(() => parseJsonMapField('f', '[1,2]')).toThrow(/f/)
    expect(() => parseJsonMapField('f', 'null')).toThrow(/f/)
    expect(() => parseJsonMapField('f', 42)).toThrow(/f/)
  })
})

describe('配置页元数据（schemastery meta → DSH 渲染）', () => {
  const asDict = (schema: { dict?: Record<string, any> }): Record<string, any> => schema.dict ?? {}

  it('密码字段走 secret 角色遮蔽回显', () => {
    const connection = asDict(Config as any).connection
    expect(asDict(connection).password.meta.role).toBe('secret')
    const query = asDict(Config as any).query
    expect(asDict(asDict(query).rest).wtToken.meta.role).toBe('secret')
  })

  it('JSON 映射字段走 textarea 角色', () => {
    const query = asDict(Config as any).query
    expect(asDict(query).cubeTypeMapJson.meta.role).toBe('textarea')
    expect(asDict(query).granularityMapJson.meta.role).toBe('textarea')
  })

  it('分组可折叠且带中文说明；字段带 description', () => {
    const connection = asDict(Config as any).connection
    expect(connection.meta.collapse).toBe(true)
    expect(connection.meta.description).toContain('StarRocks')
    expect(asDict(connection).host.meta.description).toBeTruthy()
    const system = asDict(Config as any).system
    expect(asDict(system).timeZone.meta.description).toBeTruthy()
  })

  it('timeZone 带 ±HH:MM pattern 校验', () => {
    const system = asDict(Config as any).system
    expect(asDict(system).timeZone.meta.pattern?.source).toContain('+')
  })

  it('readOnly 不出现在页面（P0 红线不开放配置）', () => {
    const security = asDict(Config as any).security
    expect(asDict(security).readOnly).toBeUndefined()
  })

  it('知识面 API Key 走 secret 角色；分组可折叠带说明', () => {
    const knowledge = asDict(Config as any).knowledge
    expect(asDict(knowledge).ragflowApiKey.meta.role).toBe('secret')
    expect(knowledge.meta.collapse).toBe(true)
    expect(knowledge.meta.description).toContain('RAGFlow')
  })
})

describe('工具组开关（toolsets）', () => {
  const conn = { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'WT_DB' }

  it('默认全开：24 个工具（现状兼容）', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    expect(service.tools).toHaveLength(24)
    expect(service.tools.map((t) => t.name)).toContain('lookup_tag')
    expect(service.tools.map((t) => t.name)).toContain('model_relation_graph')
    expect(service.tools.map((t) => t.name)).toContain('model_field_list')
    expect(service.tools.map((t) => t.name)).toContain('query_model')
  })

  it('云端 API 形态（sql=false）：仅 API 面 + 知识面 12 个，无任何 SQL 工具', () => {
    const service = createAskdataService({
      connection: conn,
      toolsets: { sql: false, api: true, knowledge: true },
    })
    const names = service.tools.map((t) => t.name)
    expect(names).toHaveLength(12)
    expect(names).toEqual(expect.arrayContaining([
      'generate_duty_report', 'list_duty_stations', 'model_relation_graph', 'model_field_list',
      'relation_field_list', 'query_model', 'query_model_segment', 'query_relation_segment',
      'knowledge_graph', 'knowledge_search', 'knowledge_wiki_page', 'knowledge_mindmap',
    ]))
    for (const sqlTool of ['lookup_tag', 'lookup_model', 'resolve_tag', 'time_series', 'latest_value', 'aggregate', 'askdata_deep_analysis']) {
      expect(names).not.toContain(sqlTool)
    }
  })

  it('纯 SQL 形态（api=false, knowledge=false）：内网取数面 12 个', () => {
    const service = createAskdataService({
      connection: conn,
      toolsets: { sql: true, api: false, knowledge: false },
    })
    const names = service.tools.map((t) => t.name)
    expect(names).toHaveLength(12) // P0 五 + P1 六 + deep_analysis
    expect(names).not.toContain('model_relation_graph')
    expect(names).not.toContain('knowledge_search')
  })
})

describe('installPreset 的 presetId 白名单（路径插值防护）', () => {
  function ctxWithLogs(): { ctx: never; warns: Array<{ msg: string; args: unknown[] }> } {
    const warns: Array<{ msg: string; args: unknown[] }> = []
    const ctx = {
      logger: {
        info: () => {},
        warn: (msg: string, ...args: unknown[]) => { warns.push({ msg, args }) },
      },
    } as never
    return { ctx, warns }
  }

  it('非法 presetId 跳过安装并告警（告警带实际 presetId），不抛异常打断启动', async () => {
    for (const bad of ['../evil', 'Askdata', 'a/b', '', '1abc', 'a'.repeat(42)]) {
      const { ctx, warns } = ctxWithLogs()
      await expect(installPreset(ctx, bad)).resolves.toBe(false)
      expect(warns).toHaveLength(1)
      expect(warns[0]!.msg).toContain('presetId "%s" 非法')
      expect(warns[0]!.args[0]).toBe(bad) // 告警文案带实际 presetId，而不是硬编码 'askdata'
    }
  })

  it('合法 kebab-case 形态通过白名单（真的装进隔离的 DSH_HOME 临时目录）', async () => {
    // 装到临时 DSH_HOME，绝不碰用户真实的 ~/.dsh；装完即删。
    const home = mkdtempSync(join(tmpdir(), 'askdata-preset-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { ctx, warns } = ctxWithLogs()
      await expect(installPreset(ctx, 'askdata-api')).resolves.toBe(true)
      expect(warns).toHaveLength(0)
      expect(existsSync(join(home, '.agent-presets', 'askdata-api', 'agent.cordis.yml'))).toBe(true)
      // 幂等：已存在则跳过，不告警
      await expect(installPreset(ctx, 'askdata-api')).resolves.toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})
