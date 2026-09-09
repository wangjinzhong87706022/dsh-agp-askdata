import { describe, expect, it } from 'vitest'
import { mapDriverError, normalizeDriverRow } from '../src/clients/starrocks-mysql2.ts'
import { resolveConfig } from '../src/config.ts'
import { AskdataError } from '../src/errors.ts'

describe('mapDriverError', () => {
  it('连接级错误 → BACKEND_DOWN', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR', 'PROTOCOL_CONNECTION_LOST']) {
      const err = mapDriverError({ code, message: 'boom' })
      expect(err.code).toBe('BACKEND_DOWN')
    }
  })
  it('sqlState 42 开头 → WT_SQL_PARSE_ERROR', () => {
    const err = mapDriverError({ code: 'ER_PARSE_ERROR', sqlState: '42000', message: 'syntax' })
    expect(err.code).toBe('WT_SQL_PARSE_ERROR')
  })
  it('未知错误 → BACKEND_DOWN 兜底', () => {
    expect(mapDriverError(new Error('weird')).code).toBe('BACKEND_DOWN')
  })
  it('错误消息截断到 300 字符且都是 AskdataError', () => {
    const err = mapDriverError({ message: 'x'.repeat(400) })
    expect(err).toBeInstanceOf(AskdataError)
    expect(err.message.length).toBeLessThanOrEqual(320)
  })
})

describe('normalizeDriverRow', () => {
  it('null/undefined → null，非字符串 String 化，字符串原样', () => {
    expect(
      normalizeDriverRow({ a: null, b: undefined, c: 174, d: 'HWNBYC174_1O_DEV001', e: 3.14 }),
    ).toEqual({ a: null, b: null, c: '174', d: 'HWNBYC174_1O_DEV001', e: '3.14' })
  })
})

describe('connection.driver 配置', () => {
  const base = { host: 'fe', port: 9030, user: 'u', password: 'p', database: 'agp' }
  it('默认 mysql2', () => {
    expect(resolveConfig({ connection: { ...base } }).connection.driver).toBe('mysql2')
  })
  it('显式 cli 生效', () => {
    expect(resolveConfig({ connection: { ...base, driver: 'cli' } }).connection.driver).toBe('cli')
  })
  it('非法值加载期报错', () => {
    expect(() => resolveConfig({ connection: { ...base, driver: 'odbc' as never } })).toThrow(/driver/)
  })
})
