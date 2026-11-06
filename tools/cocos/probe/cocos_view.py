"""把导出的 prefab 嵌进探针工程的场景里看(不走 PrefabInstance,直接把节点树搬进场景),并挂上采帧组件。

用法:python cocos_view.py <名字>…    名字是 export 目录下的骨架名,或 p1(探针自己的 Sprite 场景)
  - 读 <probe>/assets/export/<名字>/<名字>.prefab
  - 写 <probe>/assets/view_<名字>.scene(Canvas + 相机 + 这棵节点树,角色缩到 0.3 倍好看全貌)
  - 每个场景的 Canvas 挂 AgcCapture(tools/cocos/probe/AgcCapture.ts,拷进工程):定格采帧、POST 给 collect.mjs,
    然后跳到参数里的下一个场景,最后一个发 all_done 标记
  - build*.json 的 scenes 加上这些场景,startScene 指到第一个
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cocos_probe import ROOT, fid, meta, p1, scene, uid, write_json  # noqa: E402

SCALE = 0.3
HERE = os.path.dirname(os.path.abspath(__file__))
BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
CAPTURE_UUID = uid('script/AgcCapture')


def compress_uuid(u):
    """脚本类在 prefab / 场景里的 __type__:uuid 的 23 字符压缩形式(同 src/cocos/ids.ts 的 compressUuid)"""
    h = u.replace('-', '')
    out = h[:5]
    for i in range(5, 32, 3):
        v = int(h[i:i + 3], 16)
        out += BASE64[v >> 6] + BASE64[v & 63]
    return out


def install_capture():
    dst = f'{ROOT}/assets/AgcCapture.ts'
    shutil.copyfile(f'{HERE}/AgcCapture.ts', dst)
    meta(dst, 'typescript', CAPTURE_UUID, ver='4.0.24')


def capture(doc, canvas, tag, nxt):
    doc.comp(canvas, compress_uuid(CAPTURE_UUID), tag=tag, steps=4, next=nxt, server='http://127.0.0.1:8082')


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
    install_capture()
    scenes = []
    for k, n in enumerate(names):
        sname = n if n == 'p1' else f'view_{n}'
        nxt = names[k + 1] if k + 1 < len(names) else ''
        nxt = nxt if nxt in ('', 'p1') else f'view_{nxt}'
        after = lambda doc, canvas, n=n, nxt=nxt: capture(doc, canvas, n, nxt)
        if n == 'p1':
            sid = scene('p1', p1, after)
        else:
            sid = scene(sname, lambda doc, canvas, n=n: embed(doc, canvas, n), after)
        scenes.append({'url': f'db://assets/{sname}.scene', 'uuid': sid})
        print('scene', sname, sid, '→', nxt or '(end)')
    for fname in ('build.json', 'build-legacy.json', 'build-windows.json'):
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
