/**
 * askdata skill 注册单测：name 合法、description ≤ 200、4 个常量稳定、注册接口形态。
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ASKDATA_SKILLS,
  assertAskdataSkillShape,
  apply,
  name,
  inject,
} from '../src/dsh/skills.ts'

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

describe('ASKDATA_SKILLS 常量', () => {
  it('导出 4 个 skill 且 name 全部 kebab-case 合法', () => {
    expect(ASKDATA_SKILLS).toHaveLength(4)
    for (const s of ASKDATA_SKILLS) {
      expect(s.name, s.name).toMatch(NAME_RE)
    }
  })

  it('description 单一职责：一行能读完、≤ 200 字符', () => {
    for (const s of ASKDATA_SKILLS) {
      expect(s.description.length).toBeGreaterThan(10)
      expect(s.description.length).toBeLessThanOrEqual(200)
      // 第一行就是完整描述（不换行假装多行）
      expect(s.description.split('\n')).toHaveLength(1)
    }
  })

  it('4 个 skill 覆盖排查/编码/工作流/配置四个正交主题', () => {
    const names = ASKDATA_SKILLS.map((s) => s.name).sort()
    expect(names).toEqual(
      ['askdata-config', 'askdata-query-pattern', 'askdata-tagname', 'askdata-troubleshoot'].sort(),
    )
  })

  it('content 是有效 Markdown（首部有 # 标题），且 whenToUse 可选', () => {
    for (const s of ASKDATA_SKILLS) {
      expect(s.content).toMatch(/^#/m)
      expect(s.content.length).toBeGreaterThan(200)
      // whenToUse 是路由提示，不是必填
      if (s.whenToUse) {
        expect(s.whenToUse.length).toBeGreaterThan(20)
      }
    }
  })

  it('assertAskdataSkillShape 加载期 fail loud', () => {
    expect(() => assertAskdataSkillShape()).not.toThrow()
  })
})

describe('askdata-skills cordis 行形态', () => {
  it('name 与 inject 与 dsh-tools 风格一致', () => {
    expect(name).toBe('askdata-skills')
    expect(inject).toContain('skills')
    expect(inject).toContain('askdata')
  })

  it('apply 注册全部 skill，modelInvocable + userInvocable 双开', () => {
    const registered: Array<Record<string, unknown>> = []
    const skills = {
      register: (s: Record<string, unknown>) => {
        registered.push(s)
        return () => {}
      },
    }
    const dispose: Array<() => void> = []
    const ctx = {
      skills,
      effect: (_fn: () => () => void, _label: string) => {
        // effect 回调（disposer）现场执行以验证挂载顺序
        dispose.push(_fn())
      },
    } as never
    apply(ctx)
    expect(registered).toHaveLength(4)
    for (const s of registered) {
      expect(s.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(s.source).toBe('runtime')
      expect(s.provider).toBe('runtime')
    }
    expect(dispose).toHaveLength(4) // 每个 skill 注册都对应一个 disposer
  })

  it('apply 在 ctx.skills 缺席时优雅跳过（不抛错）', () => {
    expect(() => apply({} as never)).not.toThrow()
  })
})

describe('verify 注册路径在宿主 services 可用时不抛（运行时烟雾）', () => {
  it('mock 的 skills.register 被精确调用 4 次，参数顺序稳定', () => {
    const spy: ReturnType<typeof vi.fn> = vi.fn(() => () => {})
    apply({ skills: { register: spy as unknown as (s: unknown) => () => void }, effect: () => {} } as never)
    expect(spy).toHaveBeenCalledTimes(4)
    const names = (spy.mock.calls as unknown as Array<[{ name: string }]>).map((c) => c[0].name)
    expect(names).toEqual(ASKDATA_SKILLS.map((s) => s.name))
  })
})
