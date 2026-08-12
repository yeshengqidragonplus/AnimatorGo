import { afterEach, describe, expect, it } from 'vitest'
import { clearMigrations, convert, detectVersion, registerMigration, versionPath } from './registry.ts'
import { IssueCollector, type Migration, type SpineJson } from './types.ts'

/** 只记录自己被调用过,不做真实变换 —— 这里测的是调度,不是具体迁移 */
function tracer(from: Migration['from'], to: Migration['to']): Migration {
  return {
    from,
    to,
    up(json, issues) {
      issues.add('info', 'trace', `up ${from}->${to}`)
      return { ...json, trace: [...((json['trace'] as string[]) ?? []), `up:${from}->${to}`] }
    },
    down(json, issues) {
      issues.add('info', 'trace', `down ${to}->${from}`)
      return { ...json, trace: [...((json['trace'] as string[]) ?? []), `down:${to}->${from}`] }
    },
  }
}

function registerAll(): void {
  registerMigration(tracer('3.8', '4.0'))
  registerMigration(tracer('4.0', '4.1'))
  registerMigration(tracer('4.1', '4.2'))
}

const skeleton = (version: string): SpineJson => ({ skeleton: { spine: version }, bones: [] })

afterEach(() => clearMigrations())

describe('版本链', () => {
  it('相邻版本一步到位', () => {
    expect(versionPath('3.8', '4.0')).toEqual(['3.8', '4.0'])
  })

  it('跨版本沿链串联', () => {
    expect(versionPath('3.8', '4.2')).toEqual(['3.8', '4.0', '4.1', '4.2'])
  })

  it('降级是升级的逆序', () => {
    expect(versionPath('4.2', '3.8')).toEqual(['4.2', '4.1', '4.0', '3.8'])
  })

  it('同版本路径只有自己', () => {
    expect(versionPath('4.1', '4.1')).toEqual(['4.1'])
  })

  it('未知版本报错', () => {
    expect(() => versionPath('9.9' as never, '4.1')).toThrow(/未知版本/)
  })
})

describe('注册约束', () => {
  it('拒绝非相邻的迁移 —— 否则会退化成 N×N', () => {
    expect(() => registerMigration(tracer('3.8', '4.2'))).toThrow(/相邻/)
  })

  it('拒绝反向注册(降级走 down,不单独注册)', () => {
    expect(() => registerMigration(tracer('4.1', '4.0'))).toThrow(/相邻/)
  })
})

describe('转换调度', () => {
  it('升级按顺序调用每一步的 up', () => {
    registerAll()
    const { json } = convert(skeleton('3.8'), '3.8', '4.2')
    expect(json['trace']).toEqual(['up:3.8->4.0', 'up:4.0->4.1', 'up:4.1->4.2'])
  })

  it('降级逆序调用每一步的 down', () => {
    registerAll()
    const { json } = convert(skeleton('4.2'), '4.2', '3.8')
    expect(json['trace']).toEqual(['down:4.2->4.1', 'down:4.1->4.0', 'down:4.0->3.8'])
  })

  it('转换后写入目标版本号', () => {
    registerAll()
    const { json } = convert(skeleton('3.8'), '3.8', '4.1')
    expect((json['skeleton'] as Record<string, unknown>)['spine']).toBe('4.1')
  })

  it('不修改输入对象', () => {
    registerAll()
    const input = skeleton('3.8')
    convert(input, '3.8', '4.2')
    expect(input['trace']).toBeUndefined()
    expect((input['skeleton'] as Record<string, unknown>)['spine']).toBe('3.8')
  })

  it('缺少中间迁移时抛错,而不是产出半成品', () => {
    registerMigration(tracer('3.8', '4.0'))
    // 缺 4.0⇄4.1
    expect(() => convert(skeleton('3.8'), '3.8', '4.1')).toThrow(/缺少 4\.0 ⇄ 4\.1/)
  })

  it('同版本转换是空操作', () => {
    registerAll()
    const { json, report } = convert(skeleton('4.1'), '4.1', '4.1')
    expect(json['trace']).toBeUndefined()
    expect(report.issues).toHaveLength(0)
  })

  it('报告里带上实际走过的链路', () => {
    registerAll()
    const { report } = convert(skeleton('3.8'), '3.8', '4.2')
    expect(report.path).toEqual(['3.8', '4.0', '4.1', '4.2'])
  })

  it('问题带上是哪一步产生的', () => {
    registerAll()
    const { report } = convert(skeleton('3.8'), '3.8', '4.1')
    expect(report.issues.map((i) => i.path)).toEqual([
      '[3.8→4.0].trace',
      '[4.0→4.1].trace',
    ])
  })
})

describe('版本识别', () => {
  it('从 skeleton.spine 读出版本', () => {
    expect(detectVersion(skeleton('4.1'))).toBe('4.1')
  })

  it('忽略补丁号', () => {
    expect(detectVersion(skeleton('4.1.24'))).toBe('4.1')
  })

  it('不支持的版本返回 null,不猜', () => {
    expect(detectVersion(skeleton('3.6'))).toBeNull()
    expect(detectVersion({})).toBeNull()
    expect(detectVersion({ skeleton: {} })).toBeNull()
  })
})

describe('问题收集', () => {
  it('scoped 会给路径加前缀', () => {
    const issues = new IssueCollector()
    issues.scoped('animations.walk', () => {
      issues.scoped('bones.arm', () => issues.loss('rotate', '3.8 没有该曲线类型'))
    })
    expect(issues.all[0]).toMatchObject({
      level: 'loss',
      path: 'animations.walk.bones.arm.rotate',
    })
  })

  it('嵌套结束后前缀会还原', () => {
    const issues = new IssueCollector()
    issues.scoped('a', () => issues.add('info', 'x', ''))
    issues.add('info', 'y', '')
    expect(issues.all.map((i) => i.path)).toEqual(['a.x', 'y'])
  })
})
