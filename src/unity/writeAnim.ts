import { DEFAULT_WEIGHT, STEPPED_SLOPE, type UnityKeyframe } from './curve.ts'

/**
 * 写 Unity 的 `.anim`(AnimationClip)。
 *
 * 格式取自真实样本(`HP3D2/Assets/Res/test/_sample/Swap_SpriteRenderer.anim`),
 * 见 [docs/UNITY-2D.md](../../docs/UNITY-2D.md) 第 5 节。
 *
 * ⚠️ Unity 的 YAML 对缩进和键序都挑剔,而且**不是标准 YAML**
 * (`--- !u!74 &7400000` 这种标签)。所以这里手写文本而不是用 YAML 库。
 */

/** Unity 的 classID:212 = SpriteRenderer,4 = Transform */
export const CLASS_SPRITE_RENDERER = 212
export const CLASS_TRANSFORM = 4

export interface Vector3Curve {
  /** 相对剪辑根物体的路径,用 `/` 分隔;根物体为空串 */
  readonly path: string
  /** 三个分量各一条,长度必须一致(Unity 的 Vector3 曲线是逐分量存的) */
  readonly x: readonly UnityKeyframe[]
  readonly y: readonly UnityKeyframe[]
  readonly z: readonly UnityKeyframe[]
}

export interface PPtrKey {
  readonly time: number
  /** sprite 在纹理 meta 里的 internalID */
  readonly fileID: number
  /** 纹理资源的 GUID */
  readonly guid: string
}

export interface PPtrCurve {
  readonly path: string
  readonly attribute: string
  readonly classID: number
  readonly keys: readonly PPtrKey[]
}

export interface AnimClip {
  readonly name: string
  readonly sampleRate: number
  readonly loop: boolean
  readonly position: readonly Vector3Curve[]
  readonly euler: readonly Vector3Curve[]
  readonly scale: readonly Vector3Curve[]
  readonly pptr: readonly PPtrCurve[]
}

/**
 * 数字格式化。
 *
 * Unity 把无穷写成 `Infinity`(阶梯曲线要用),而 JS 的 `toString()` 给的是
 * `Infinity` —— 正好一致。整数不写小数点,与 Unity 自己的输出保持一致。
 */
function n(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity'
  if (Number.isInteger(value)) return String(value)
  // Unity 用 float 精度,写太多位既没意义又和它自己的输出对不上
  return String(Number(value.toFixed(7)))
}

/** 三个分量取同一下标的关键帧,凑成 Unity 的 Vector3 关键帧 */
function vectorKeyframe(c: Vector3Curve, i: number, indent: string): string {
  const x = c.x[i]!
  const y = c.y[i]!
  const z = c.z[i]!
  const v3 = (a: UnityKeyframe, b: UnityKeyframe, d: UnityKeyframe, k: keyof UnityKeyframe) =>
    `{x: ${n(a[k] as number)}, y: ${n(b[k] as number)}, z: ${n(d[k] as number)}}`

  return [
    `${indent}- serializedVersion: 3`,
    `${indent}  time: ${n(x.time)}`,
    `${indent}  value: ${v3(x, y, z, 'value')}`,
    `${indent}  inSlope: ${v3(x, y, z, 'inSlope')}`,
    `${indent}  outSlope: ${v3(x, y, z, 'outSlope')}`,
    // tangentMode 是编辑器用的提示,0 表示自由切线
    `${indent}  tangentMode: 0`,
    `${indent}  weightedMode: ${x.weightedMode | y.weightedMode | z.weightedMode}`,
    `${indent}  inWeight: ${v3(x, y, z, 'inWeight')}`,
    `${indent}  outWeight: ${v3(x, y, z, 'outWeight')}`,
  ].join('\n')
}

function vectorCurve(c: Vector3Curve): string {
  const lines = [
    '  - curve:',
    '      serializedVersion: 2',
    '      m_Curve:',
  ]
  for (let i = 0; i < c.x.length; i++) lines.push(vectorKeyframe(c, i, '      '))
  lines.push(
    // 2 = ClampForever:两端保持首尾值,与 Spine 的行为一致
    '      m_PreInfinity: 2',
    '      m_PostInfinity: 2',
    '      m_RotationOrder: 4',
    `    path: ${c.path}`,
  )
  return lines.join('\n')
}

function pptrCurve(c: PPtrCurve): string {
  const lines = ['  - serializedVersion: 2', '    curve:']
  for (const k of c.keys) {
    lines.push(`    - time: ${n(k.time)}`)
    // type: 3 表示引用的是子资源(sprite 是纹理的子资源)
    lines.push(`      value: {fileID: ${k.fileID}, guid: ${k.guid}, type: 3}`)
  }
  lines.push(
    `    attribute: ${c.attribute}`,
    `    path: ${c.path}`,
    `    classID: ${c.classID}`,
    '    script: {fileID: 0}',
    '    flags: 2',
  )
  return lines.join('\n')
}

function section(name: string, curves: readonly string[]): string {
  return curves.length === 0 ? `  ${name}: []` : `  ${name}:\n${curves.join('\n')}`
}

export function writeAnim(clip: AnimClip): string {
  const duration = Math.max(
    0,
    ...[...clip.position, ...clip.euler, ...clip.scale].flatMap((c) =>
      c.x.length === 0 ? [0] : [c.x[c.x.length - 1]!.time],
    ),
    ...clip.pptr.flatMap((c) => (c.keys.length === 0 ? [0] : [c.keys[c.keys.length - 1]!.time])),
  )

  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!74 &7400000',
    'AnimationClip:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    `  m_Name: ${clip.name}`,
    '  serializedVersion: 7',
    '  m_Legacy: 0',
    '  m_Compressed: 0',
    '  m_UseHighQualityCurve: 1',
    '  m_RotationCurves: []',
    '  m_CompressedRotationCurves: []',
    section('m_EulerCurves', clip.euler.map(vectorCurve)),
    section('m_PositionCurves', clip.position.map(vectorCurve)),
    section('m_ScaleCurves', clip.scale.map(vectorCurve)),
    '  m_FloatCurves: []',
    section('m_PPtrCurves', clip.pptr.map(pptrCurve)),
    `  m_SampleRate: ${n(clip.sampleRate)}`,
    '  m_WrapMode: 0',
    '  m_Bounds:',
    '    m_Center: {x: 0, y: 0, z: 0}',
    '    m_Extent: {x: 0, y: 0, z: 0}',
    '  m_ClipBindingConstant:',
    '    genericBindings: []',
    '    pptrCurveMapping: []',
    '  m_AnimationClipSettings:',
    '    serializedVersion: 2',
    '    m_AdditiveReferencePoseClip: {fileID: 0}',
    '    m_AdditiveReferencePoseTime: 0',
    '    m_StartTime: 0',
    `    m_StopTime: ${n(duration)}`,
    '    m_OrientationOffsetY: 0',
    '    m_Level: 0',
    '    m_CycleOffset: 0',
    '    m_HasAdditiveReferencePose: 0',
    `    m_LoopTime: ${clip.loop ? 1 : 0}`,
    '    m_LoopBlend: 0',
    '    m_LoopBlendOrientation: 0',
    '    m_LoopBlendPositionY: 0',
    '    m_LoopBlendPositionXZ: 0',
    '    m_KeepOriginalOrientation: 0',
    '    m_KeepOriginalPositionY: 1',
    '    m_KeepOriginalPositionXZ: 0',
    '    m_HeightFromFeet: 0',
    '    m_Mirror: 0',
    '  m_EditorCurves: []',
    '  m_EulerEditorCurves: []',
    '  m_HasGenericRootTransform: 0',
    '  m_HasMotionFloatCurves: 0',
    '  m_Events: []',
    '',
  ].join('\n')
}

export { DEFAULT_WEIGHT, STEPPED_SLOPE }
