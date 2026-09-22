/**
 * DSH 配置页测试：schema 默认值可装配、JSON 映射字段解析、页面元数据（角色/描述）。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Config, toRuntimeConfig, parseJsonMapField } from '../src/dsh/plugin.ts'
import { createAskdataService } from '../src/index.ts'
import { DEFAULT_CUBE_TYPE_MAP } from '../src/config.ts'

/** 物化 schema 默认值（loader 对 cordis.yml 配置块做的事；host/database 必填需提供）。 */
function defaultConfig(): ReturnType<typeof Config> {
  return Config({ connection: { host: 'fe.example.com', database: 'WT_DB' } }) as ReturnType<typeof Config>
}

describe('配置页默认值可装配', () => {
  it('schema 默认值经 toRuntimeConfig → createAskdataService 全程通过', () => {
    const service = createAskdataService(toRuntimeConfig(defaultConfig()))
    // P0 五 + P1 六 + subagent 一 + 知识面四 = 16
    expect(service.tools).toHaveLength(16)
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
