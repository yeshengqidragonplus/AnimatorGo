/**
 * ⚠️ **3.8 与 4.x 的贝塞尔控制点不是一个坐标系。**
 *
 * ```
 * 3.8:  [cx1, cy1, cx2, cy2] 全在 [0,1] —— 「占这一段时间/取值的百分比」
 * 4.x:  [cx1, cy1, cx2, cy2] 是绝对的时间(秒)与取值
 * ```
 *
 * 同一份动画,MX2_cat 的两个导出实测:
 *
 * ```
 * 3.8   cx ∈ [0.243, 0.758]   cy ∈ [0.00, 1.00]
 * 4.1   cx ∈ [0.058, 1.949]   cy ∈ [-139.58, 393.41]     ← 角度本身
 * ```
 *
 * **弄混了不会崩,只是所有缓入缓出悄悄变形。** 动画照播,看着也像那么回事,
 * 但节奏全不对 —— 这是本项目里最难自己发现的一类错。
 *
 * 依据是 Spine 4.x 自己的读取器:
 * ```csharp
 * // SkeletonBinary.SetBezier —— 四个 float 就是绝对的 cx1/cy1/cx2/cy2
 * timeline.SetBezier(bezier, frame, value, time1, value1,
 *                    ReadFloat(), ReadFloat() * scale, ReadFloat(), ReadFloat() * scale,
 *                    time2, value2);
 * ```
 *
 * ## 两个例外
 *
 * - **deform**:4.x 调用时传的是 `value1 = 0, value2 = 1`,取值本来就是 0..1,
 *   所以两版一致,**不需要换算**。
 * - **slot 颜色**:4.x 读的是 `字节 / 255`,贝塞尔的 cy 在 **0..1**,不是 0..255。
 *   换算时分量取值也要先除 255。
 */

/** 归一化(3.8)→ 绝对(4.x) */
export function toAbsoluteBezier(
  normalized: readonly number[],
  t0: number,
  v0: number,
  t1: number,
  v1: number,
): number[] {
  const dt = t1 - t0
  const dv = v1 - v0
  return [
    t0 + normalized[0]! * dt,
    v0 + normalized[1]! * dv,
    t0 + normalized[2]! * dt,
    v0 + normalized[3]! * dv,
  ]
}

/**
 * 绝对(4.x)→ 归一化(3.8)。
 *
 * 该分量首尾取值相同时归一化没有意义(0/0)—— 曲线怎么画结果都一样,
 * 所以直接给 0。时间相同时同理。
 */
export function toNormalizedBezier(
  absolute: readonly number[],
  t0: number,
  v0: number,
  t1: number,
  v1: number,
): number[] {
  const dt = t1 - t0
  const dv = v1 - v0
  const nx = (v: number) => (Math.abs(dt) < 1e-9 ? 0 : (v - t0) / dt)
  const ny = (v: number) => (Math.abs(dv) < 1e-9 ? 0 : (v - v0) / dv)
  return [nx(absolute[0]!), ny(absolute[1]!), nx(absolute[2]!), ny(absolute[3]!)]
}

/**
 * 该时间轴每帧可插值的数值字段,按分量顺序排。
 *
 * 3.8 与 4.x 的字段名不同(transform 约束 4 个 mix vs 6 个),所以要分版本。
 */
export function valueFieldsOf(kind: string, is38: boolean): readonly string[] | null {
  switch (kind) {
    case 'rotate':
    case 'translateX':
    case 'translateY':
    case 'scaleX':
    case 'scaleY':
    case 'shearX':
    case 'shearY':
    case 'path0':
    case 'path1':
      return ['value']
    case 'translate':
    case 'scale':
    case 'shear':
      return ['x', 'y']
    case 'ik':
      return ['mix', 'softness']
    case 'transform':
      return is38
        ? ['mixRotate', 'mixTranslate', 'mixScale', 'mixShear']
        : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']
    case 'path2':
      return is38 ? ['mixRotate', 'mixTranslate'] : ['mixRotate', 'mixX', 'mixY']
    default:
      return null
  }
}

/**
 * 取一帧里各分量的数值,**换算到贝塞尔 cy 所在的取值空间**。
 *
 * `null` 表示这条时间轴不需要换算:要么没有曲线(attachment / drawOrder / event),
 * 要么两版的取值空间本来就一致(deform 是 0..1)。
 */
export function curveValuesOf(
  kind: string,
  frame: Record<string, unknown>,
  is38: boolean,
): number[] | null {
  // 3.8 的 slot 颜色打包成 int;贝塞尔的 cy 在 0..1
  if (kind === 'color' || kind === 'twoColor') {
    const colors = frame['colors'] as number[]
    const rgba = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
    const rgb = (v: number) => [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
    const bytes = kind === 'color' ? rgba(colors[0]!) : [...rgba(colors[0]!), ...rgb(colors[1]!)]
    return bytes.map((b) => b / 255)
  }

  // 4.x 的 slot 颜色是分通道字节;同样除 255
  if (kind.startsWith('slotColor')) {
    return (frame['color'] as number[]).map((b) => b / 255)
  }

  const fields = valueFieldsOf(kind, is38)
  if (fields === null) return null
  return fields.map((name) => frame[name] as number)
}
