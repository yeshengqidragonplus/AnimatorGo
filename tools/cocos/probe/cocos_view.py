"""把导出的 prefab 嵌进探针工程的场景里看(不走 PrefabInstance,直接把节点树搬进场景)。

用法:python cocos_view.py <export 目录下的骨架名>…
  - 读 <probe>/assets/export/<名字>/<名字>.prefab
  - 写 <probe>/assets/view_<名字>.scene(Canvas + 相机 + 这棵节点树,角色缩到 0.3 倍好看全貌)
  - build.json / build-legacy.json 的 scenes 加上这些场景,startScene 指到第一个
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cocos_probe import ROOT, fid, scene, write_json  # noqa: E402

SCALE = 0.3


def embed(doc, canvas, name):
    prefab = json.load(open(f'{ROOT}/assets/export/{name}/{name}.prefab', encoding='utf-8'))
    # 旧下标 → 新下标;PrefabInfo / CompPrefabInfo 不搬,引用改成 null
    remap = {}
    kept = []
    for i, o in enumerate(prefab):
        t = o.get('__type__')
        if i == 0 or t in ('cc.PrefabInfo', 'cc.CompPrefabInfo'):
            continue
        kept.append(i)
    base = len(doc.objs)
    for k, i in enumerate(kept):
        remap[i] = base + k

    def fix(v):
        if isinstance(v, dict):
            if '__id__' in v and len(v) == 1:
                return {'__id__': remap[v['__id__']]} if v['__id__'] in remap else None
            return {kk: fix(vv) for kk, vv in v.items()}
        if isinstance(v, list):
            return [fix(x) for x in v]
        return v

    root_old = prefab[0]['data']['__id__']
    for i in kept:
        o = fix(prefab[i])
        if o.get('__type__') == 'cc.Node':
            o['_id'] = fid(f'{name}/{i}')
            if i == root_old:
                o['_parent'] = doc.ref(canvas)
                # 角色原点一般在脚下,往下挪一点居中
                o['_lpos'] = {'__type__': 'cc.Vec3', 'x': 0, 'y': -90, 'z': 0}
                o['_lscale'] = {'__type__': 'cc.Vec3', 'x': SCALE, 'y': SCALE, 'z': 1}
        doc.objs.append(o)
    doc.objs[canvas]['_children'].append(doc.ref(remap[root_old]))


def main(names):
    scenes = []
    for n in names:
        sid = scene(f'view_{n}', lambda doc, canvas, n=n: embed(doc, canvas, n))
        scenes.append({'url': f'db://assets/view_{n}.scene', 'uuid': sid})
        print('scene', f'view_{n}', sid)
    for fname in ('build.json', 'build-legacy.json'):
        p = f'{ROOT}/{fname}'
        if not os.path.exists(p):
            continue
        b = json.load(open(p, encoding='utf-8'))
        have = {s['uuid'] for s in b['scenes']}
        b['scenes'] += [s for s in scenes if s['uuid'] not in have]
        b['startScene'] = scenes[0]['uuid']
        write_json(p, b)


if __name__ == '__main__':
    main(sys.argv[1:])
