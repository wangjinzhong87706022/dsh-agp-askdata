/**
 * 服务装配级测试：白名单闸门在执行器咽喉点收口（调用点遗漏也无法绕过）、
 * 工具面完整性（11 工具）、MySQL 业务库未配置的运行期守卫。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createAskdataService } from '../src/index.ts'
import { AskdataError } from '../src/errors.ts'

function service() {
  return createAskdataService({
    connection: { host: 'fe.example.com', port: 9030, user: 'u', password: 'p', database: 'agp' },
  })
}

describe('服务装配', () => {
  it('暴露全部 11 个工具（P0 五 + P1 六）', () => {
    expect(service().tools.map((t) => t.name)).toEqual([
      'lookup_tag',
      'estimate_count',
      'latest_value',
      'time_series',
      'aggregate',
      'lookup_model',
      'lookup_object',
      'lookup_tag_definition',
      'resolve_tag',
      'query_alarm',
      'query_alarm_config',
    ])
  })

  it('TSDB 执行器咽喉点闸门：DML 在触达驱动前被拒', async () => {
    const svc = service()
    const ctx = svc.createContext()
    await expect(ctx.executor.execute('UPDATE WT_DATA SET value = 0')).rejects.toMatchObject({
      code: 'DML_FORBIDDEN',
    })
  })

  it('TSDB 执行器咽喉点闸门：白名单外表在触达驱动前被拒', async () => {
    const svc = service()
    const ctx = svc.createContext()
    await expect(ctx.executor.execute('SELECT * FROM mysql.user')).rejects.toMatchObject({
      code: 'SENSITIVE_TABLE',
    })
  })

  it('MySQL 执行器共用闸门（mysqlTableWhitelist）', async () => {
    const svc = service()
    const ctx = svc.createContext()
    await expect(
      ctx.mysqlExecutor.execute('SELECT * FROM other_db.secret'),
    ).rejects.toMatchObject({ code: 'SENSITIVE_TABLE' })
    await expect(
      ctx.mysqlExecutor.execute('DELETE FROM wisetao_meta.wt_elm_equipment'),
    ).rejects.toMatchObject({ code: 'DML_FORBIDDEN' })
  })

  it('MySQL 业务库未配置 → P1 工具得到明确 BACKEND_DOWN（而非驱动错误）', async () => {
    const svc = service()
    const ctx = svc.createContext()
    const result = await svc.tools.find((t) => t.name === 'lookup_model')!.run({}, ctx)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BACKEND_DOWN')
    expect(result.errorMessage).toContain('mysqlConnection')
  })

  it('P0 工具入参校验在触达执行器之前（不依赖 MySQL 配置、无网络）', async () => {
    const svc = service()
    const ctx = svc.createContext()
    // 注入特征在 validateFilterText 即被拒，不触达执行器
    const result = await svc.tools.find((t) => t.name === 'lookup_tag')!.run(
      { keyword: 'a; DROP TABLE x' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_PARAM')
  })

  it('非法 timeZone 在创建期失败', () => {
    expect(() =>
      createAskdataService({
        connection: { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' },
        system: { timeZone: 'Asia/Shanghai' },
      }),
    ).toThrow(/timeZone/)
  })

  it('AskdataError 从闸门抛出（不带裸 Error）', async () => {
    const svc = service()
    const ctx = svc.createContext()
    await expect(ctx.executor.execute('UPDATE WT_DATA SET value = 0')).rejects.toBeInstanceOf(
      AskdataError,
    )
  })
})
