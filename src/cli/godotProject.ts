import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** 输出目录所在的 Godot 工程根(有 project.godot 的那层);不在工程里返回 null */
export function findGodotProject(outDir: string): string | null {
  let dir = resolve(outDir)
  for (let up = 0; up < 16; up++) {
    if (existsSync(join(dir, 'project.godot'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 产物目录在 Godot 工程里的 `res://` 路径;不在工程里返回空串(贴图按相对路径引用) */
export function godotResDir(project: string | null, dir: string): string {
  return project === null ? '' : `res://${relative(project, dir).split(sep).join('/')}`
}
