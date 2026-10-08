/**
 * `ProjectSettings/QualitySettings.asset` 里各档位的 Skin Weights。
 *
 * 它是 SkinnedMeshRenderer 每顶点蒙皮根数的**上限**(2026-10-08 实测,BakeMesh):渲染器的 `m_Quality`
 * 写 Bone4 也盖不过,档位设成 2 根就只用 2 根。SpriteSkin 不受影响 —— 2D Animation 的蒙皮是包自己做的,
 * 源码里没碰 QualitySettings,1 根和 4 根渲出来逐字节相同。
 */

/** Skin Weights 的 Unlimited */
export const UNLIMITED_SKIN_WEIGHTS = 255

export interface QualityLevel {
  readonly name: string
  /** 1 / 2 / 4,255 = Unlimited */
  readonly skinWeights: number
}

/** 2019.1 之前叫 `blendWeights`(取值同样是 1 / 2 / 4),两个都有时以 `skinWeights` 为准 */
export function parseQualitySkinWeights(text: string): QualityLevel[] {
  const levels: { name: string; skinWeights: number | null; legacy: number | null }[] = []
  // 按 \r?\n 切:git 在 Windows 上可能把它检出成 CRLF,而 `.` 不吃 \r,行尾一个 \r 就整行匹配不上
  for (const line of text.split(/\r?\n/)) {
    const name = /^ {4}name: (.*)$/.exec(line)
    if (name !== null) {
      levels.push({ name: name[1]!.trim(), skinWeights: null, legacy: null })
      continue
    }
    const current = levels[levels.length - 1]
    if (current === undefined) continue
    const sw = /^ {4}(skinWeights|blendWeights): (\d+)/.exec(line)
    if (sw === null) continue
    if (sw[1] === 'skinWeights') current.skinWeights = Number(sw[2])
    else current.legacy = Number(sw[2])
  }
  return levels.flatMap((l) => {
    const skinWeights = l.skinWeights ?? l.legacy
    return skinWeights === null ? [] : [{ name: l.name, skinWeights }]
  })
}

export function skinWeightsLabel(skinWeights: number): string {
  return skinWeights === UNLIMITED_SKIN_WEIGHTS ? 'Unlimited' : `${skinWeights} 根`
}
