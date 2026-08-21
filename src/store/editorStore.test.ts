import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore.ts'
import { SAMPLE_SKELETON, SAMPLE_WALK } from '@core/sample.ts'
import { PROJECT_FORMAT_VERSION } from '@project/types.ts'

const store = () => useEditorStore.getState()

const setupRotationOf = (name: string) =>
  store().doc.skeleton.bones.find((b) => b.name === name)!.rotation

const keysOf = (name: string) =>
  store().doc.animations.get(store().currentAnimation)?.bones.get(name)?.rotate ?? []

const keyAt = (name: string, time: number) => keysOf(name).find((k) => k.time === time)

beforeEach(() => {
  useEditorStore.setState({
    doc: {
      formatVersion: PROJECT_FORMAT_VERSION,
      name: 'sample',
      images: [],
      atlases: [],
      skeleton: SAMPLE_SKELETON,
      animations: new Map([[SAMPLE_WALK.name, SAMPLE_WALK]]),
    },
    past: [],
    future: [],
    lastMergeKey: null,
    mode: 'setup',
    currentAnimation: SAMPLE_WALK.name,
    time: 0,
    playing: false,
    selectedBone: null,
    projectDir: null,
  })
})

describe('绑定姿势模式', () => {
  it('拖动骨骼改的是绑定姿势', () => {
    store().setBoneRotation('torso', 45)
    expect(setupRotationOf('torso')).toBe(45)
    expect(store().past).toHaveLength(1)
  })

  it('不会往动画里写关键帧', () => {
    const before = keysOf('torso').length
    store().setBoneRotation('torso', 45)
    expect(keysOf('torso')).toHaveLength(before)
  })
})

describe('动画模式', () => {
  beforeEach(() => useEditorStore.setState({ mode: 'animate', time: 0.5 }))

  it('拖动骨骼在当前时刻打关键帧', () => {
    store().setBoneRotation('head', 20)
    expect(keyAt('head', 0.5)?.value).toBe(20) // head 绑定姿势是 0°
  })

  it('关键帧存的是相对绑定姿势的偏移,不是绝对角', () => {
    // hip 的绑定姿势旋转是 90°
    store().setBoneRotation('hip', 120)
    expect(keyAt('hip', 0.5)?.value).toBe(30) // 120 − 90
  })

  it('不修改绑定姿势', () => {
    store().setBoneRotation('hip', 120)
    expect(setupRotationOf('hip')).toBe(90)
  })

  it('同一时刻重复打帧是替换而非追加', () => {
    store().setBoneRotation('head', 10)
    store().setBoneRotation('head', 20)
    expect(keysOf('head').filter((k) => k.time === 0.5)).toHaveLength(1)
    expect(keyAt('head', 0.5)?.value).toBe(20)
  })

  it('关键帧按时间有序插入', () => {
    useEditorStore.setState({ time: 0.7 })
    store().setBoneRotation('head', 1)
    useEditorStore.setState({ time: 0.2 })
    store().setBoneRotation('head', 2)
    expect(keysOf('head').map((k) => k.time)).toEqual([0.2, 0.7])
  })

  it('超出原时长的关键帧会延长动画', () => {
    useEditorStore.setState({ time: 2.5 })
    store().setBoneRotation('head', 1)
    expect(store().doc.animations.get(SAMPLE_WALK.name)!.duration).toBe(2.5)
  })

  it('右键删除关键帧', () => {
    const before = keysOf('thigh_l').length
    store().deleteKeyframe('thigh_l', 'rotate', 0.25)
    expect(keysOf('thigh_l')).toHaveLength(before - 1)
    expect(keyAt('thigh_l', 0.25)).toBeUndefined()
  })
})

describe('TRS 编辑', () => {
  const timelinesOf = (name: string) =>
    store().doc.animations.get(store().currentAnimation)?.bones.get(name)

  describe('绑定姿势模式', () => {
    it('平移/缩放/斜切写入绑定姿势', () => {
      store().setBoneTranslation('torso', 5, -3)
      store().setBoneScale('torso', 2, 0.5)
      store().setBoneShear('torso', 10, -10)
      const bone = store().doc.skeleton.bones.find((b) => b.name === 'torso')!
      expect([bone.x, bone.y]).toEqual([5, -3])
      expect([bone.scaleX, bone.scaleY]).toEqual([2, 0.5])
      expect([bone.shearX, bone.shearY]).toEqual([10, -10])
    })

    it('length 只影响绑定数据,动画模式下也一样', () => {
      useEditorStore.setState({ mode: 'animate' })
      store().setBoneLength('torso', 120)
      expect(store().doc.skeleton.bones.find((b) => b.name === 'torso')!.length).toBe(120)
      expect(timelinesOf('torso')?.translate).toBeUndefined()
    })
  })

  describe('动画模式', () => {
    beforeEach(() => useEditorStore.setState({ mode: 'animate', time: 0.5 }))

    it('平移关键帧存偏移:绝对值 − 绑定值', () => {
      // torso 绑定位置 (0, 40)
      const bind = store().doc.skeleton.bones.find((b) => b.name === 'torso')!
      store().setBoneTranslation('torso', bind.x + 7, bind.y - 2)
      expect(timelinesOf('torso')?.translate?.[0]).toMatchObject({ time: 0.5, x: 7, y: -2 })
      // 不动绑定姿势
      expect(store().doc.skeleton.bones.find((b) => b.name === 'torso')!.x).toBe(bind.x)
    })

    it('缩放关键帧存比值:绝对值 ÷ 绑定值', () => {
      store().setBoneScale('torso', 2, 0.5) // 绑定 scale 是 1,1
      expect(timelinesOf('torso')?.scale?.[0]).toMatchObject({ time: 0.5, x: 2, y: 0.5 })
    })

    it('斜切关键帧存偏移', () => {
      store().setBoneShear('torso', 15, -5)
      expect(timelinesOf('torso')?.shear?.[0]).toMatchObject({ time: 0.5, x: 15, y: -5 })
    })

    it('打关键帧固化所有已有通道在当前时刻的插值结果', () => {
      // thigh_l 在 SAMPLE_WALK 里有 rotate 时间轴;再补一条 translate
      store().setBoneTranslation('thigh_l', 4, 0)
      useEditorStore.setState({ time: 0.6 })
      store().keyBoneAtTime('thigh_l')

      const timelines = timelinesOf('thigh_l')!
      expect(timelines.rotate!.some((k) => k.time === 0.6)).toBe(true)
      expect(timelines.translate!.some((k) => k.time === 0.6)).toBe(true)
      // 没碰过的通道不会被打帧
      expect(timelines.scale).toBeUndefined()
    })

    it('一条时间轴都没有时,打关键帧落一个 rotate 零帧', () => {
      store().keyBoneAtTime('head')
      expect(timelinesOf('head')?.rotate?.[0]).toMatchObject({ time: 0.5, value: 0 })
    })

    it('按通道删除关键帧,不影响其他通道', () => {
      store().setBoneTranslation('thigh_l', 4, 0)
      store().deleteKeyframe('thigh_l', 'translate', 0.5)
      expect(timelinesOf('thigh_l')?.translate).toHaveLength(0)
      expect(timelinesOf('thigh_l')?.rotate?.length).toBeGreaterThan(0)
    })
  })
})

describe('slot 编辑', () => {
  const imageA = { id: 'image:a.png', path: 'a.png', width: 10, height: 10 }
  const imageB = { id: 'image:b.png', path: 'b.png', width: 10, height: 10 }

  const slotNames = () => store().doc.skeleton.slots.map((slot) => slot.name)
  const skinOf = (index: number) => store().doc.skeleton.skins.get('default')?.get(index)

  beforeEach(() => {
    store().addImages([imageA, imageB])
    store().bindImageToBone(imageA.id, 'torso')
    store().bindImageToBone(imageB.id, 'head')
  })

  it('改名保留绑定,拒绝重名', () => {
    store().renameSlot('slot_image:a.png', 'body')
    expect(slotNames()).toContain('body')
    expect(store().doc.skeleton.slots.find((slot) => slot.name === 'body')?.attachment).toBe(imageA.id)
    expect(() => store().renameSlot('slot_image:b.png', 'body')).toThrow('slot 名称重复')
  })

  it('删除 slot 时皮肤下标跟着重排', () => {
    // slot 0 = a,slot 1 = b;删掉 0 之后 b 的 attachment 必须还能查到
    store().removeSlot('slot_image:a.png')
    expect(slotNames()).toEqual(['slot_image:b.png'])
    expect(skinOf(0)?.get(imageB.id)).toBeDefined()
    expect(skinOf(1)).toBeUndefined()
  })

  it('调整绘制顺序时皮肤下标跟着交换', () => {
    store().moveSlot('slot_image:a.png', 1)
    expect(slotNames()).toEqual(['slot_image:b.png', 'slot_image:a.png'])
    expect(skinOf(0)?.get(imageB.id)).toBeDefined()
    expect(skinOf(1)?.get(imageA.id)).toBeDefined()

    // 已在顶层,再往上是空操作
    store().moveSlot('slot_image:a.png', 1)
    expect(slotNames()).toEqual(['slot_image:b.png', 'slot_image:a.png'])
  })

  it('颜色和混合模式可编辑、可撤销', () => {
    store().setSlotColor('slot_image:a.png', { r: 1, g: 0, b: 0, a: 0.5 })
    store().setSlotBlend('slot_image:a.png', 'additive')
    const slot = () => store().doc.skeleton.slots.find((s) => s.name === 'slot_image:a.png')!
    expect(slot().color).toEqual({ r: 1, g: 0, b: 0, a: 0.5 })
    expect(slot().blend).toBe('additive')

    store().undo()
    expect(slot().blend).toBe('normal')
  })

  it('重复绑定同一图片保留已改的颜色和混合模式', () => {
    store().setSlotColor('slot_image:a.png', { r: 0, g: 1, b: 0, a: 1 })
    store().bindImageToBone(imageA.id, 'head')
    expect(store().doc.skeleton.slots.find((s) => s.attachment === imageA.id)?.color).toEqual({ r: 0, g: 1, b: 0, a: 1 })
  })
})

describe('图片部件绑定', () => {
  const image = { id: 'image:body.png', path: 'body.png', width: 64, height: 128 }

  it('导入图片创建可撤销的项目资源记录', () => {
    store().addImages([image])
    expect(store().doc.images).toEqual([image])
    expect(store().past).toHaveLength(1)
  })

  it('把图片绑定到骨骼时创建 slot 和 region attachment', () => {
    store().addImages([image])
    store().bindImageToBone(image.id, 'torso')

    const slotIndex = store().doc.skeleton.slots.findIndex((slot) => slot.attachment === image.id)
    expect(slotIndex).toBeGreaterThanOrEqual(0)
    expect(store().doc.skeleton.slots[slotIndex]?.bone).toBe(2)
    // attachment.path 用图片文件名 —— 和图集区域名一致,见 looseAtlas.ts
    expect(store().doc.skeleton.skins.get('default')?.get(slotIndex)?.get(image.id)).toMatchObject({
      type: 'region', path: image.path, width: 64, height: 128,
    })
  })

  it('重复绑定同一图片会换骨骼而不是创建重叠 slot', () => {
    store().addImages([image])
    store().bindImageToBone(image.id, 'torso')
    store().bindImageToBone(image.id, 'head')

    expect(store().doc.skeleton.slots.filter((slot) => slot.attachment === image.id)).toHaveLength(1)
    expect(store().doc.skeleton.slots.find((slot) => slot.attachment === image.id)?.bone).toBe(3)
  })
})

describe('骨骼编辑', () => {
  it('给选中骨骼添加子骨骼，父骨骼保持在数组之前', () => {
    const name = store().addBone('torso')
    const child = store().doc.skeleton.bones.find((bone) => bone.name === name)!
    expect(child.parent).toBe(2)
    expect(store().doc.skeleton.bones.indexOf(child)).toBeGreaterThan(child.parent)
  })

  it('空项目可以从根骨骼开始', () => {
    useEditorStore.setState({ doc: {
      formatVersion: PROJECT_FORMAT_VERSION, name: 'empty', images: [], atlases: [],
      skeleton: { name: 'empty', bones: [], slots: [], skins: new Map([['default', new Map()]]), defaultSkin: 'default' },
      animations: new Map(),
    } })
    const name = store().addBone(null)
    expect(store().doc.skeleton.bones.find((bone) => bone.name === name)?.parent).toBe(-1)
  })
})

describe('撤销重做', () => {
  it('相同 merge key 的连续编辑合并成一条 —— 一次拖动 = 一次撤销', () => {
    for (let i = 1; i <= 100; i++) {
      store().setBoneRotation('torso', i, 'rotate:torso:1')
    }
    expect(store().past).toHaveLength(1)
    expect(setupRotationOf('torso')).toBe(100)

    store().undo()
    expect(setupRotationOf('torso')).toBe(SAMPLE_SKELETON.bones[2]!.rotation)
  })

  it('不同 merge key 各自成一条 —— 两次拖动 = 两次撤销', () => {
    store().setBoneRotation('torso', 10, 'rotate:torso:1')
    store().setBoneRotation('torso', 20, 'rotate:torso:1')
    store().setBoneRotation('torso', 30, 'rotate:torso:2')
    expect(store().past).toHaveLength(2)

    store().undo()
    expect(setupRotationOf('torso')).toBe(20)
  })

  it('不传 merge key 时不会互相合并', () => {
    store().setBoneRotation('torso', 10)
    store().setBoneRotation('torso', 20)
    expect(store().past).toHaveLength(2)
  })

  it('撤销后重做回到原值', () => {
    store().setBoneRotation('head', 33)
    store().undo()
    store().redo()
    expect(setupRotationOf('head')).toBe(33)
    expect(store().future).toHaveLength(0)
  })

  it('撤销后的新编辑清空重做栈', () => {
    store().setBoneRotation('head', 10)
    store().setBoneRotation('head', 20)
    store().undo()
    expect(store().future).toHaveLength(1)

    store().setBoneRotation('head', 99)
    expect(store().future).toHaveLength(0)
  })

  it('撤销后紧接的同 key 编辑不会被误合并进已恢复的状态', () => {
    store().setBoneRotation('head', 10, 'k')
    store().undo()
    store().setBoneRotation('head', 20, 'k')

    // 若 lastMergeKey 没在 undo 时清掉,这次会替换而不压栈,导致撤销不回去
    expect(store().past).toHaveLength(1)
    store().undo()
    expect(setupRotationOf('head')).toBe(SAMPLE_SKELETON.bones[3]!.rotation)
  })

  it('空栈时撤销重做是安全的空操作', () => {
    expect(() => {
      store().undo()
      store().redo()
    }).not.toThrow()
    expect(store().doc.skeleton).toBe(SAMPLE_SKELETON)
  })

  it('编辑不修改原文档 —— 快照之间结构共享', () => {
    const before = store().doc.skeleton
    store().setBoneRotation('torso', 77)

    expect(before.bones[2]!.rotation).not.toBe(77)
    expect(store().doc.skeleton.bones[0]).toBe(before.bones[0]) // 未改动的骨骼是同一引用
  })

  it('播放头和播放状态不进历史 —— 撤销不该把播放头拽回去', () => {
    store().setBoneRotation('torso', 45)
    store().setTime(0.8)
    store().setPlaying(true)

    expect(store().past).toHaveLength(1) // 只有那次旋转
    store().undo()
    expect(store().time).toBe(0.8) // 播放头没被撤销影响
  })
})
