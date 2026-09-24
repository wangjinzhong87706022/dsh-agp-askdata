import { describe, expect, it } from 'vitest'
import { adaptAskdataTool, renderAskdataResult, toParametersJsonSchema } from '../src/dsh/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { QueryOutput } from '../src/clients/starrocks.ts'
import type { AskdataTool, SqlExecutor, ToolContext } from '../tools/types.ts'
import { lookupTagTool } from '../tools/lookup-tag.ts'
import { AskdataError } from '../src/errors.ts'

function makeContext(respond: (sql: string) => QueryOutput, signal?: AbortSignal): ToolContext {
  const config = resolveConfig({
    connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
  })
  const executor: SqlExecutor = { execute: async (sql) => respond(sql) }
  return { config, executor, mysqlExecutor: executor, signal }
}

describe('toParametersJsonSchema', () => {
  it('required 提升到顶层，禁额外属性', () => {
    const schema = toParametersJsonSchema(lookupTagTool.inputSchema)
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['keyword'])
    const properties = schema.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(['keyword', 'data_type', 'granularity', 'limit'])
  })
})

describe('adaptAskdataTool', () => {
  it('成功路径返回 canonical 值', async () => {
    const def = adaptAskdataTool(lookupTagTool, () =>
      makeContext(() => ({
        columns: ['tagName', 'tagIndex', 'dataType', 'comment'],
        rows: [{ tagName: 'T_1O_D1', tagIndex: '7', dataType: '2', comment: '告警' }],
      })),
    )
    expect(def.name).toBe('lookup_tag')
    const value = (await def.execute({ keyword: '告警' }, {})) as { rowCount: number; data: unknown[] }
    expect(value.rowCount).toBe(1)
    expect(value.data[0]).toEqual({ tagName: 'T_1O_D1', tagIndex: 7, dataType: 2, comment: '告警' })
  })

  it('工具失败 → execute 抛出带规范错误码的异常', async () => {
    const def = adaptAskdataTool(lookupTagTool, () => makeContext(() => ({ columns: [], rows: [] })))
    await expect(def.execute({}, {})).rejects.toMatchObject({ code: 'INVALID_PARAM' })
    await expect(def.execute({}, {})).rejects.toBeInstanceOf(AskdataError)
  })

  it('取消信号透传到工具上下文（预检前即拒绝）', async () => {
    const controller = new AbortController()
    controller.abort()
    let touched = false
    const tool: AskdataTool = {
      ...lookupTagTool,
      run: async (args, ctx) => {
        touched = ctx.signal?.aborted === true
        return lookupTagTool.run(args, ctx)
      },
    }
    const def = adaptAskdataTool(tool, (signal) =>
      makeContext(() => {
        touched = true
        return { columns: [], rows: [] }
      }, signal),
    )
    await expect(def.execute({ keyword: 'x' }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'BACKEND_DOWN',
    })
    expect(touched).toBe(true)
  })

  it('render 产出文本块且大结果截断展示', () => {
    const def = adaptAskdataTool(lookupTagTool, () =>
      makeContext(() => ({ columns: [], rows: [] })),
    )
    const output = def.output as {
      render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }
    const value = {
      success: true,
      toolName: 'lookup_tag',
      apiOrSql: 'SELECT 1',
      fields: [{ name: 'tagName', title: '测点', type: 'string' }],
      data: Array.from({ length: 25 }, (_, i) => ({ tagName: `t${i}` })),
      rowCount: 25,
      executionMs: 5,
      auditId: 'a1',
    }
    const blocks = output.render({}, value)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('仅展示前 20 行')
    const rendered = renderAskdataResult(value)
    expect(rendered).toContain('"rowCount": 25')
  })

  it('previewLimit 由工具自声明：meta 面 300 行内不截断', async () => {
    const metaLike: AskdataTool = {
      ...lookupTagTool,
      name: 'meta_like',
      previewLimit: 300,
    }
    const def = adaptAskdataTool(metaLike, () => makeContext(() => ({ columns: [], rows: [] })))
    const output = def.output as {
      render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }
    const value = {
      success: true,
      toolName: 'meta_like',
      apiOrSql: 'GET x',
      fields: [],
      data: Array.from({ length: 51 }, (_, i) => ({ rank: i + 1 })),
      rowCount: 51,
      executionMs: 5,
      auditId: 'a1',
    }
    const blocks = output.render({}, value)
    expect(blocks[0]!.text).not.toContain('truncatedPreview')
    expect(blocks[0]!.text).toContain('"rank": 51') // 51 行全部在预览内
    expect(renderAskdataResult(value, 300)).not.toContain('truncatedPreview')
  })

  it('total/complete 完整性契约透传到 canonical 值与模型可见渲染', async () => {
    const def = adaptAskdataTool(lookupTagTool, () =>
      makeContext(() => ({ columns: [], rows: [] })),
    )
    const value = {
      success: true,
      toolName: 'query_model',
      apiOrSql: 'POST x',
      fields: [],
      data: Array.from({ length: 25 }, (_, i) => ({ id: i })),
      rowCount: 25,
      executionMs: 5,
      auditId: 'a1',
      total: 51,
      complete: false,
    }
    const output = def.output as {
      render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }
    const text = output.render({}, value)[0]!.text
    expect(text).toContain('"total": 51')
    expect(text).toContain('"complete": false')
    expect(text).toContain('仅展示前 20 行，共 51 行')
    expect(text).toContain('truncatedPreview')
  })

  it('presentCall 标题含工具名与参数摘要', () => {
    const def = adaptAskdataTool(lookupTagTool, () => makeContext(() => ({ columns: [], rows: [] })))
    const view = def.presentCall?.({ keyword: '告警' }) as { title: string; card: string }
    expect(view.card).toBe('generic')
    expect(view.title).toContain('lookup_tag')
    expect(view.title).toContain('告警')
  })
})
