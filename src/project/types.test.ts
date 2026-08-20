import { describe, expect, it } from 'vitest'
import { SAMPLE_SKELETON, SAMPLE_WALK } from '@core/sample.ts'
import { createEmptyProject, fromProjectDocument, toProjectDocument } from './types.ts'

describe('项目格式', () => {
  it('空项目带有可绑定 attachment 的默认皮肤', () => {
    const project = createEmptyProject('角色')
    expect(project.formatVersion).toBe(1)
    expect(project.skeleton.skins.has('default')).toBe(true)
  })

  it('Map 形式的皮肤和动画可往返为 JSON 友好的项目文档', () => {
    const project = {
      ...createEmptyProject('walk'),
      images: [{ id: 'body', path: 'body.png', width: 128, height: 256 }],
      skeleton: SAMPLE_SKELETON,
      animations: new Map([[SAMPLE_WALK.name, SAMPLE_WALK]]),
    }

    const document = toProjectDocument(project)
    const reloaded = fromProjectDocument(JSON.parse(JSON.stringify(document)))

    expect(reloaded.images).toEqual(project.images)
    expect(reloaded.skeleton.bones).toEqual(SAMPLE_SKELETON.bones)
    expect(reloaded.animations.get('walk')?.bones.get('thigh_l')?.rotate).toEqual(
      SAMPLE_WALK.bones.get('thigh_l')?.rotate,
    )
  })

  it('拒绝未知项目格式版本', () => {
    const document = toProjectDocument(createEmptyProject())
    expect(() => fromProjectDocument({ ...document, formatVersion: 2 } as never)).toThrow('不支持的项目文件版本')
  })
})
