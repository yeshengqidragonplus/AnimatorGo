import { fileId } from './ids.ts'

/**
 * 写 AnimatorController。
 *
 * 光有 `.anim` 是**播不起来的** —— Unity 的 Animator 要一个 controller 才知道播哪条。
 * 这里给每条剪辑生成一个 state,第一条设为默认状态,不做任何过渡。
 *
 * 结构取自真实样本(`_sample/SampleCharacter.controller`)。
 *
 * 生成的是最朴素的一层状态机:需要混合、过渡、参数的话在 Unity 里接着编辑就行,
 * 这里只负责让它**能播**。
 */

/** AnimatorController 主对象在文件里的固定 fileID —— Unity 自己也是这个值 */
export const CONTROLLER_FILE_ID = 9100000
/** AnimationClip 主对象在 `.anim` 里的固定 fileID */
export const CLIP_FILE_ID = 7400000

export const CLASS_ANIMATOR_CONTROLLER = 91
export const CLASS_ANIMATOR_STATE = 1102
export const CLASS_ANIMATOR_STATE_MACHINE = 1107

export interface ControllerClip {
  readonly name: string
  /** 该 `.anim` 资源的 GUID */
  readonly guid: string
}

const COMMON_HEADER = [
  '  m_CorrespondingSourceObject: {fileID: 0}',
  '  m_PrefabInstance: {fileID: 0}',
  '  m_PrefabAsset: {fileID: 0}',
]

export function writeController(name: string, clips: readonly ControllerClip[]): string {
  const machineId = fileId(`${name}/statemachine`)
  const stateIds = clips.map((c) => fileId(`${name}/state/${c.name}`))

  const docs: string[] = [
    [
      `--- !u!${CLASS_ANIMATOR_CONTROLLER} &${CONTROLLER_FILE_ID}`,
      'AnimatorController:',
      '  m_ObjectHideFlags: 0',
      ...COMMON_HEADER,
      `  m_Name: ${name}`,
      '  serializedVersion: 5',
      '  m_AnimatorParameters: []',
      '  m_AnimatorLayers:',
      '  - serializedVersion: 5',
      '    m_Name: Base Layer',
      `    m_StateMachine: {fileID: ${machineId}}`,
      '    m_Mask: {fileID: 0}',
      '    m_Motions: []',
      '    m_Behaviours: []',
      '    m_BlendingMode: 0',
      '    m_SyncedLayerIndex: -1',
      '    m_DefaultWeight: 0',
      '    m_IKPass: 0',
      '    m_SyncedLayerAffectsTiming: 0',
      `    m_Controller: {fileID: ${CONTROLLER_FILE_ID}}`,
    ].join('\n'),
  ]

  clips.forEach((clip, i) => {
    docs.push(
      [
        `--- !u!${CLASS_ANIMATOR_STATE} &${stateIds[i]!}`,
        'AnimatorState:',
        '  serializedVersion: 6',
        // 1 = HideInHierarchy,子对象都是这个
        '  m_ObjectHideFlags: 1',
        ...COMMON_HEADER,
        `  m_Name: ${clip.name}`,
        '  m_Speed: 1',
        '  m_CycleOffset: 0',
        '  m_Transitions: []',
        '  m_StateMachineBehaviours: []',
        `  m_Position: {x: 50, y: ${50 + i * 60}, z: 0}`,
        '  m_IKOnFeet: 0',
        '  m_WriteDefaultValues: 1',
        '  m_Mirror: 0',
        '  m_SpeedParameterActive: 0',
        '  m_MirrorParameterActive: 0',
        '  m_CycleOffsetParameterActive: 0',
        '  m_TimeParameterActive: 0',
        `  m_Motion: {fileID: ${CLIP_FILE_ID}, guid: ${clip.guid}, type: 2}`,
        '  m_Tag: ',
        '  m_SpeedParameter: ',
        '  m_MirrorParameter: ',
        '  m_CycleOffsetParameter: ',
        '  m_TimeParameter: ',
      ].join('\n'),
    )
  })

  const childStates = clips.flatMap((_, i) => [
    '  - serializedVersion: 1',
    `    m_State: {fileID: ${stateIds[i]!}}`,
    `    m_Position: {x: 300, y: ${i * 80}, z: 0}`,
  ])

  docs.push(
    [
      `--- !u!${CLASS_ANIMATOR_STATE_MACHINE} &${machineId}`,
      'AnimatorStateMachine:',
      '  serializedVersion: 6',
      '  m_ObjectHideFlags: 1',
      ...COMMON_HEADER,
      '  m_Name: Base Layer',
      clips.length === 0 ? '  m_ChildStates: []' : `  m_ChildStates:\n${childStates.join('\n')}`,
      '  m_ChildStateMachines: []',
      '  m_AnyStateTransitions: []',
      '  m_EntryTransitions: []',
      '  m_StateMachineTransitions: {}',
      '  m_StateMachineBehaviours: []',
      '  m_AnyStatePosition: {x: 50, y: 20, z: 0}',
      '  m_EntryPosition: {x: 50, y: 120, z: 0}',
      '  m_ExitPosition: {x: 800, y: 120, z: 0}',
      '  m_ParentStateMachinePosition: {x: 800, y: 20, z: 0}',
      `  m_DefaultState: {fileID: ${stateIds[0] ?? 0}}`,
    ].join('\n'),
  )

  return `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n${docs.join('\n')}\n`
}
