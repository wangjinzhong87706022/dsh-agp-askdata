import { describe, expect, it } from 'vitest'
import { buildMysqlArgs, parseTsvOutput, unescapeField } from '../src/clients/starrocks.ts'
import { DEFAULT_LIMITS_FOR_TEST } from './helpers.ts'

const limits = DEFAULT_LIMITS_FOR_TEST
const connection = {
  host: 'fe.example.com',
  port: 9030,
  user: 'askdata',
  password: 'SECRET',
  database: 'agp',
}

describe('buildMysqlArgs', () => {
  it('密码与 SQL 都绝不进入 argv', () => {
    const args = buildMysqlArgs(connection, limits)
    expect(args).not.toContain('SECRET')
    expect(args.join(' ')).not.toContain('SECRET')
    expect(args.join(' ')).not.toContain('SELECT')
  })
  it('含 host/port/user/database 与 batch 模式；SQL 由 stdin 送达', () => {
    const args = buildMysqlArgs(connection, limits)
    expect(args).toContain('-h')
    expect(args).toContain('fe.example.com')
    expect(args).toContain('9030')
    expect(args).toContain('--batch')
    expect(args).toContain('--default-character-set=utf8mb4')
    expect(args).not.toContain('-e')
  })
})

describe('unescapeField', () => {
  it('NULL 字面量 → null', () => {
    expect(unescapeField('NULL')).toBeNull()
  })
  it('转义还原', () => {
    expect(unescapeField('a\\tb')).toBe('a\tb')
    expect(unescapeField('a\\nb')).toBe('a\nb')
    expect(unescapeField('a\\\\b')).toBe('a\\b')
  })
  it('普通串原样', () => {
    expect(unescapeField('HWNBYC174_1O_DEV001')).toBe('HWNBYC174_1O_DEV001')
  })
})

describe('parseTsvOutput', () => {
  it('首行列名 + 数据行', () => {
    const out = parseTsvOutput('tagName\tlatestValue\nA_1O_D1\t3.14\nB_2O_D2\tNULL\n')
    expect(out.columns).toEqual(['tagName', 'latestValue'])
    expect(out.rows).toEqual([
      { tagName: 'A_1O_D1', latestValue: '3.14' },
      { tagName: 'B_2O_D2', latestValue: null },
    ])
  })
  it('空输出', () => {
    expect(parseTsvOutput('')).toEqual({ columns: [], rows: [] })
  })
})
