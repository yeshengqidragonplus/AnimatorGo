import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseQualitySkinWeights } from './qualitySettings.ts'

describe('工程 Quality 的 Skin Weights', () => {
  it('UnityAnimationGo 自己的 QualitySettings.asset(Unity 6000.3 写的)', () => {
    const text = readFileSync('UnityAnimationGo/ProjectSettings/QualitySettings.asset', 'utf8')
    expect(parseQualitySkinWeights(text)).toEqual([
      { name: 'Very Low', skinWeights: 1 },
      { name: 'Low', skinWeights: 2 },
      { name: 'Medium', skinWeights: 2 },
      { name: 'High', skinWeights: 2 },
      { name: 'Very High', skinWeights: 4 },
      { name: 'Ultra', skinWeights: 255 },
    ])
  })

  it('2019.1 之前叫 blendWeights;两个都有时以 skinWeights 为准;CRLF 也能读', () => {
    const text = [
      'QualitySettings:',
      '  m_QualitySettings:',
      '  - serializedVersion: 2',
      '    name: Fast',
      '    blendWeights: 2',
      '  - serializedVersion: 2',
      '    name: Good',
      '    blendWeights: 1',
      '    skinWeights: 4',
    ].join('\r\n')
    expect(parseQualitySkinWeights(text)).toEqual([
      { name: 'Fast', skinWeights: 2 },
      { name: 'Good', skinWeights: 4 },
    ])
  })
})
