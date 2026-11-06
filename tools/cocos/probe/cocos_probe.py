"""Cocos Creator 3.8.8 探针工程生成器(P1:2D Sprite + Sorting2D + Animation 各种轨道)。

生成到 C:/Users/zhe.huang/AppData/Local/Temp/agc/probe,所有 uuid 由名字决定,重跑结果一样。
"""
import base64
import hashlib
import json
import math
import os
import shutil
import sys

from PIL import Image, ImageDraw

ROOT = 'C:/Users/zhe.huang/AppData/Local/Temp/agc/probe'
UI_2D = 1 << 25
DEFAULT_LAYER = 1 << 30
# BlendFactor
ZERO, ONE, SRC_ALPHA, DST_ALPHA, ONE_MINUS_SRC_ALPHA, ONE_MINUS_DST_ALPHA, SRC_COLOR, DST_COLOR, ONE_MINUS_SRC_COLOR = range(9)
# RealInterpolationMode
LINEAR, CONSTANT, CUBIC = 0, 1, 2
# ExtrapolationMode
EXTRA_LINEAR, EXTRA_CLAMP, EXTRA_LOOP = 0, 1, 2
# WrapMode
WRAP_NORMAL, WRAP_LOOP = 1, 2


def uid(name):
    h = hashlib.sha1(('agc:' + name).encode()).hexdigest()
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}'


def fid(name):
    return base64.b64encode(hashlib.sha1(('fid:' + name).encode()).digest()[:16]).decode()[:22]


def vec3(x=0.0, y=0.0, z=0.0):
    return {'__type__': 'cc.Vec3', 'x': x, 'y': y, 'z': z}


def vec2(x=0.0, y=0.0):
    return {'__type__': 'cc.Vec2', 'x': x, 'y': y}


def color(r, g, b, a=255):
    return {'__type__': 'cc.Color', 'r': r, 'g': g, 'b': b, 'a': a}


def quat_z(deg):
    h = math.radians(deg) / 2
    return {'__type__': 'cc.Quat', 'x': 0, 'y': 0, 'z': math.sin(h), 'w': math.cos(h)}


class Doc:
    def __init__(self):
        self.objs = []

    def add(self, o):
        self.objs.append(o)
        return len(self.objs) - 1

    @staticmethod
    def ref(i):
        return {'__id__': i}

    def node(self, name, parent, pos=(0, 0), rot=0.0, scale=(1, 1), layer=UI_2D, active=True):
        i = self.add({
            '__type__': 'cc.Node', '_name': name, '_objFlags': 0, '_parent': None if parent is None else self.ref(parent),
            '_children': [], '_active': active, '_components': [], '_prefab': None,
            '_lpos': vec3(pos[0], pos[1], pos[2] if len(pos) > 2 else 0), '_lrot': quat_z(rot),
            '_lscale': vec3(scale[0], scale[1], 1), '_mobility': 0, '_layer': layer, '_euler': vec3(0, 0, rot), '_id': fid(name),
        })
        if parent is not None:
            self.objs[parent]['_children'].append(self.ref(i))
        return i

    def comp(self, node, type_, **fields):
        o = {'__type__': type_, '_name': '', '_objFlags': 0, 'node': self.ref(node), '_enabled': True, '__prefab': None}
        o.update(fields)
        o['_id'] = ''
        i = self.add(o)
        self.objs[node]['_components'].append(self.ref(i))
        return i

    def ui_transform(self, node, w, h, ax=0.5, ay=0.5):
        return self.comp(node, 'cc.UITransform', _contentSize={'__type__': 'cc.Size', 'width': w, 'height': h}, _anchorPoint=vec2(ax, ay))

    def sprite(self, node, frame_uuid, src=SRC_ALPHA, dst=ONE_MINUS_SRC_ALPHA, tint=None):
        return self.comp(
            node, 'cc.Sprite', _materials=[], _visFlags=0, _customMaterial=None, _srcBlendFactor=src, _dstBlendFactor=dst,
            _color=tint or color(255, 255, 255), _spriteFrame={'__uuid__': frame_uuid}, _type=0, _fillType=0, _sizeMode=0,
            _fillCenter=vec2(), _fillStart=0, _fillRange=0, _isTrimmedMode=False, _useGrayscale=False, _atlas=None,
        )


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def meta(path, importer, uuid, user=None, ver=None):
    m = {'importer': importer, 'imported': False, 'uuid': uuid, 'files': [], 'subMetas': {}, 'userData': user or {}}
    if ver:
        m = {'ver': ver, **m}
    write_json(path + '.meta', m)


# ── 贴图 ──
def png(name, rgba, size=(64, 48), gradient=False):
    im = Image.new('RGBA', size, rgba)
    d = ImageDraw.Draw(im)
    if gradient:
        for x in range(size[0]):
            a = int(255 * x / (size[0] - 1))
            d.line([(x, 0), (x, size[1])], fill=(rgba[0], rgba[1], rgba[2], a))
    # 左下角一个深色小方块,看朝向用
    d.rectangle([2, size[1] - 10, 10, size[1] - 2], fill=(0, 0, 0, 255))
    p = f'{ROOT}/assets/img/{name}.png'
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p)
    meta(p, 'image', uid(f'img/{name}'), {'type': 'sprite-frame', 'hasAlpha': True, 'fixAlphaTransparencyArtifacts': False}, ver='1.0.27')
    return uid(f'img/{name}') + '@f9941'


# ── 动画轨道 ──
def real_curve(keys, mode=LINEAR, tangents=None):
    """keys: [(t, v), …];tangents: [(left, right), …] 配合 CUBIC"""
    values = []
    for i, (t, v) in enumerate(keys):
        kv = {'__type__': 'cc.RealKeyframeValue', 'value': v, 'interpolationMode': mode, 'tangentWeightMode': 0,
              'rightTangent': 0, 'rightTangentWeight': 0, 'leftTangent': 0, 'leftTangentWeight': 0, 'easingMethod': 0}
        if tangents:
            kv['leftTangent'], kv['rightTangent'] = tangents[i]
        values.append(kv)
    return {'__type__': 'cc.RealCurve', '_times': [t for t, _ in keys], '_values': values, 'preExtrapolation': EXTRA_CLAMP, 'postExtrapolation': EXTRA_CLAMP}


def empty_curve():
    return {'__type__': 'cc.RealCurve', '_times': [], '_values': [], 'preExtrapolation': EXTRA_CLAMP, 'postExtrapolation': EXTRA_CLAMP}


def channel(curve):
    return {'__type__': 'cc.animation.Channel', '_curve': curve}


def binding(paths):
    ps = []
    for p in paths:
        if isinstance(p, tuple):
            kind, v = p
            ps.append({'__type__': 'cc.animation.HierarchyPath', 'path': v} if kind == 'node' else {'__type__': 'cc.animation.ComponentPath', 'component': v})
        else:
            ps.append(p)
    return {'__type__': 'cc.animation.TrackBinding', 'path': {'__type__': 'cc.animation.TrackPath', '_paths': ps}, 'proxy': None}


def vector_track(paths, n, curves):
    chs = [channel(curves[i] if i < len(curves) and curves[i] is not None else empty_curve()) for i in range(4)]
    return {'__type__': 'cc.animation.VectorTrack', '_binding': binding(paths), '_channels': chs, '_nComponents': n}


def real_track(paths, curve):
    return {'__type__': 'cc.animation.RealTrack', '_binding': binding(paths), '_channel': channel(curve)}


def object_track(paths, keys):
    return {'__type__': 'cc.animation.ObjectTrack', '_binding': binding(paths),
            '_channel': channel({'__type__': 'cc.ObjectCurve', '_times': [t for t, _ in keys], '_values': [v for _, v in keys]})}


def clip(name, duration, tracks, wrap=WRAP_LOOP):
    doc = Doc()
    root = doc.add({
        '__type__': 'cc.AnimationClip', '_name': name, '_objFlags': 0, '_native': '', 'sample': 60, 'speed': 1, 'wrapMode': wrap,
        'enableTrsBlending': False, '_duration': duration, '_hash': 0, '_tracks': [], '_exoticAnimation': None, '_events': [],
        '_embeddedPlayers': [], '_additiveSettings': None, '_auxiliaryCurveEntries': [],
    })
    for t in tracks:
        doc.objs[root]['_tracks'].append(doc.ref(doc.add(t)))
    doc.objs[root]['_additiveSettings'] = doc.ref(doc.add({'__type__': 'cc.AnimationClipAdditiveSettings', 'enabled': False, 'refClip': None}))
    p = f'{ROOT}/assets/{name}.anim'
    write_json(p, doc.objs)
    meta(p, 'animation-clip', uid(f'anim/{name}'))
    return uid(f'anim/{name}')


# ── 场景 ──
def scene(name, build, after=None):
    """build(doc, canvas_node) 往画布下加东西;after(doc, canvas_node) 最后再挂点东西(采帧组件)"""
    doc = Doc()
    sid = uid(f'scene/{name}')
    doc.add({'__type__': 'cc.SceneAsset', '_name': name, '_objFlags': 0, '_native': '', 'scene': doc.ref(1), 'asyncLoadAssets': False})
    sc = doc.add({'__type__': 'cc.Scene', '_name': name, '_objFlags': 0, '_parent': None, '_children': [], '_active': True, '_components': [],
                  '_prefab': None, 'autoReleaseAssets': False, '_globals': None, '_id': sid})
    canvas = doc.node('Canvas', sc, pos=(480, 320))
    doc.ui_transform(canvas, 960, 640)
    cam_node = doc.node('Camera', canvas, pos=(0, 0, 1000), layer=DEFAULT_LAYER)
    cam = doc.comp(cam_node, 'cc.Camera', _projection=0, _priority=0, _fov=45, _fovAxis=0, _orthoHeight=320, _near=0, _far=2000,
                   _color=color(0, 0, 0), _depth=1, _stencil=0, _clearFlags=7, _rect={'__type__': 'cc.Rect', 'x': 0, 'y': 0, 'width': 1, 'height': 1},
                   _aperture=19, _shutter=7, _iso=0, _screenScale=1, _visibility=1108344832, _targetTexture=None)
    doc.comp(canvas, 'cc.Canvas', _cameraComponent=doc.ref(cam), _alignCanvasWithScreen=True)
    build(doc, canvas)
    if after:
        after(doc, canvas)
    g = doc.add({'__type__': 'cc.SceneGlobals', 'ambient': None, 'shadows': None, '_skybox': None, 'fog': None})
    doc.objs[g]['ambient'] = doc.ref(doc.add({'__type__': 'cc.AmbientInfo', '_skyColorHDR': {'__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.5, 'z': 0.8, 'w': 0.520833125}, '_skyIllumHDR': 20000, '_groundAlbedoHDR': {'__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.2, 'z': 0.2, 'w': 1}, '_skyColor': {'__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.5, 'z': 0.8, 'w': 0.520833125}, '_skyIllum': 20000, '_groundAlbedo': {'__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.2, 'z': 0.2, 'w': 1}}))
    doc.objs[g]['shadows'] = doc.ref(doc.add({'__type__': 'cc.ShadowsInfo', '_enabled': False, '_type': 0, '_normal': vec3(0, 1, 0), '_distance': 0, '_planeBias': 1, '_shadowColor': color(0, 0, 0, 76), '_maxReceived': 4, '_size': vec2(1024, 1024)}))
    doc.objs[g]['_skybox'] = doc.ref(doc.add({'__type__': 'cc.SkyboxInfo', '_envLightingType': 0, '_envmapHDR': None, '_envmap': None, '_envmapLDR': None, '_diffuseMapHDR': None, '_diffuseMapLDR': None, '_enabled': False, '_useHDR': True, '_editableMaterial': None, '_reflectionHDR': None, '_reflectionLDR': None, '_rotationAngle': 0}))
    doc.objs[g]['fog'] = doc.ref(doc.add({'__type__': 'cc.FogInfo', '_type': 0, '_fogColor': color(200, 200, 200), '_enabled': False, '_fogDensity': 0.3, '_fogStart': 0.5, '_fogEnd': 300, '_fogAtten': 5, '_fogTop': 1.5, '_fogRange': 1.2, '_accurate': False}))
    doc.objs[sc]['_globals'] = doc.ref(g)
    p = f'{ROOT}/assets/{name}.scene'
    write_json(p, doc.objs)
    meta(p, 'scene', sid, ver='1.1.27')
    return sid


def p1(doc, canvas):
    red = png('red', (220, 40, 40, 255))
    green = png('green', (40, 200, 40, 255))
    blue = png('blue', (40, 80, 230, 255))
    yellow = png('yellow', (240, 220, 40, 255))
    white = png('white', (255, 255, 255, 255))
    grad = png('grad', (255, 255, 255, 255), gradient=True)
    grey = png('grey', (128, 128, 128, 255), size=(400, 300))

    root = doc.node('root', canvas)
    doc.ui_transform(root, 0, 0)

    def spr(name, frame, pos, order=None, src=SRC_ALPHA, dst=ONE_MINUS_SRC_ALPHA, opacity=None, scale=(1, 1)):
        n = doc.node(name, root, pos=pos, scale=scale)
        doc.ui_transform(n, 64, 48)
        doc.sprite(n, frame, src, dst)
        if order is not None:
            doc.comp(n, 'cc.Sorting2D', _sortingLayer=0, _sortingOrder=order)
        if opacity is not None:
            doc.comp(n, 'cc.UIOpacity', _opacity=opacity)
        return n

    bg = doc.node('bg', root)
    doc.ui_transform(bg, 400, 300)
    doc.sprite(bg, grey)
    doc.comp(bg, 'cc.Sorting2D', _sortingLayer=0, _sortingOrder=-10)
    spr('a', red, (-100, 60), order=1)
    spr('b', green, (-60, 60), order=2)
    spr('c', blue, (60, 60), order=1)
    spr('d', blue, (140, 60), order=1)
    spr('e', white, (-100, -60), order=1, opacity=255)
    spr('g', grad, (60, -60), order=1, src=ONE, dst=ONE)

    tracks = [
        # a:位置 x 线性 -100 → 100;y 三次,两端切线 0(ease in-out)
        vector_track([('node', 'a'), 'position'], 3, [real_curve([(0, -100), (2, 100)]), real_curve([(0, 60), (2, 160)], CUBIC, [(0, 0), (0, 0)])]),
        # a:绕 z 转 0 → 90
        vector_track([('node', 'a'), 'eulerAngles'], 3, [None, None, real_curve([(0, 0), (2, 90)])]),
        # a:缩放 1 → 1.5
        vector_track([('node', 'a'), 'scale'], 3, [real_curve([(0, 1), (2, 1.5)]), real_curve([(0, 1), (2, 1.5)])]),
        # b:排序 2 → 0(阶梯),1 秒后压到 a 下面
        real_track([('node', 'b'), ('comp', 'cc.Sorting2D'), 'sortingOrder'], real_curve([(0, 2), (1, 0)], CONSTANT)),
        # c:1 秒换图 蓝 → 黄
        object_track([('node', 'c'), ('comp', 'cc.Sprite'), 'spriteFrame'], [(0, {'__uuid__': blue}), (1, {'__uuid__': yellow})]),
        # d:1 秒 active 关掉
        object_track([('node', 'd'), 'active'], [(0, True), (1, False)]),
        # e:不透明度 255 → 0
        real_track([('node', 'e'), ('comp', 'cc.UIOpacity'), 'opacity'], real_curve([(0, 255), (2, 0)])),
    ]
    c = clip('p1', 2, tracks)
    doc.comp(root, 'cc.Animation', playOnLoad=True, _clips=[{'__uuid__': c}], _defaultClip={'__uuid__': c})


UNLIT_EFFECT = 'a3cd009f-0ab0-420d-9278-b9fdab939bbc'


def gltf_ids():
    """编辑器导入过 glTF 才有:{importer 名: 'uuid@id'}"""
    p = f'{ROOT}/assets/skin/strip.gltf.meta'
    if not os.path.exists(p):
        return None
    m = json.load(open(p, encoding='utf-8'))
    if not m.get('imported'):
        return None
    out = {}
    for sub in m['subMetas'].values():
        out.setdefault(sub['importer'], []).append((sub.get('name') or sub.get('displayName'), sub['uuid']))
    return out


def material(name, texture_uuid, tech=1, blend=False):
    p = f'{ROOT}/assets/{name}.mtl'
    target = {'blend': True, 'blendSrc': 2, 'blendDst': 4, 'blendSrcAlpha': 2, 'blendDstAlpha': 4} if blend else {}
    write_json(p, {
        '__type__': 'cc.Material', '_name': '', '_objFlags': 0, '_native': '', '_effectAsset': {'__uuid__': UNLIT_EFFECT}, '_techIdx': tech,
        '_defines': [{'USE_TEXTURE': True}],
        '_states': [{'blendState': {'targets': [target]}, 'depthStencilState': {'depthTest': False, 'depthWrite': False}, 'rasterizerState': {'cullMode': 0}}],
        '_props': [{'mainTexture': {'__uuid__': texture_uuid}, 'mainColor': color(255, 255, 255)}],
    })
    meta(p, 'material', uid(f'mtl/{name}'), ver='1.0.9')
    return uid(f'mtl/{name}')


def p2(doc, canvas, ids, sorting):
    """蒙皮网格 + morph 放进 UI(UIMeshRenderer),夹在两个 Sprite 中间看先后"""
    red = uid('img/red') + '@f9941'
    green = uid('img/green') + '@f9941'
    grey = uid('img/grey') + '@f9941'
    tex = uid('img/red') + '@6c48a'
    mesh_id = [u for n, u in ids['gltf-mesh']][0]
    skel_id = [u for n, u in ids['gltf-skeleton']][0]
    mtl0 = material('strip_t0', tex, tech=0, blend=True)
    mtl1 = material('strip_t1', tex, tech=1)

    root = doc.node('root', canvas)
    doc.ui_transform(root, 0, 0)

    def spr(name, frame, pos, order, size=(64, 48)):
        n = doc.node(name, root, pos=pos)
        doc.ui_transform(n, *size)
        doc.sprite(n, frame)
        if sorting:
            doc.comp(n, 'cc.Sorting2D', _sortingLayer=0, _sortingOrder=order)
        return n

    spr('bg', grey, (0, 0), -10, (400, 300))
    # 节点顺序:under → 网格 → over。under 的 sortingOrder 5(大),over 的 1(小):
    # 有 Sorting2D 时按 priority 应该 over 先画、under 后画(压在网格上);没有时按节点顺序
    spr('under', red, (-20, 0), 5)
    def mesh_common(mtl):
        return dict(_materials=[{'__uuid__': mtl}], _visFlags=0, lightmapSettings=None, _mesh={'__uuid__': mesh_id},
                    _shadowCastingMode=0, _shadowReceivingMode=0, _shadowBias=0, _shadowNormalBias=0, _reflectionProbeType=0,
                    _bakeToReflectionProbe=False, _reflectionProbeId=-1, _reflectionProbeBlendId=-1, _reflectionProbeBlendWeight=0,
                    _enabledGlobalStandardSkinObject=False, _enableMorph=True)

    # 蒙皮网格的骨骼要和 glTF 里的层级同名:关节路径是 skin_root/j0、skin_root/j0/j1,从 skinningRoot(= skin_root 的父级)算起
    for label, x, mtl in (('s0', -120, mtl0), ('s1', 0, mtl1)):
        holder = doc.node(f'holder_{label}', root, pos=(x, -60))
        doc.ui_transform(holder, 0, 0)
        skin_root = doc.node('skin_root', holder)
        j0 = doc.node('j0', skin_root)
        doc.node('j1', j0, pos=(0, 40))
        strip = doc.node('strip', skin_root)
        doc.ui_transform(strip, 64, 160)
        doc.comp(strip, 'cc.SkinnedMeshRenderer', _skeleton={'__uuid__': skel_id}, _skinningRoot=doc.ref(holder), **mesh_common(mtl))
        doc.comp(strip, 'cc.UIMeshRenderer')
    static = doc.node('static', root, pos=(120, -60))
    doc.ui_transform(static, 64, 160)
    doc.comp(static, 'cc.MeshRenderer', **mesh_common(mtl0))
    doc.comp(static, 'cc.UIMeshRenderer')
    spr('over', green, (20, 0), 1)

    tracks = [
        # j1 摆动 -45 → 45
        vector_track([('node', f'holder_{label}/skin_root/j0/j1'), 'eulerAngles'], 3, [None, None, real_curve([(0, -45), (1, 45), (2, -45)])])
        for label in ('s0', 's1')
    ] + [
        # morph 权重 0 → 1 → 0
        {'__type__': 'cc.animation.RealTrack',
         '_binding': {'__type__': 'cc.animation.TrackBinding',
                      'path': {'__type__': 'cc.animation.TrackPath', '_paths': [{'__type__': 'cc.animation.HierarchyPath', 'path': f'holder_{label}/skin_root/strip'}, {'__type__': 'cc.animation.ComponentPath', 'component': 'cc.SkinnedMeshRenderer'}]},
                      'proxy': {'__type__': 'cc.animation.MorphWeightValueProxy', 'subMeshIndex': 0, 'shapeIndex': 0}},
         '_channel': channel(real_curve([(0, 0), (1, 1), (2, 0)]))}
        for label in ('s0', 's1')
    ]
    c = clip('p2' if sorting else 'p2b', 2, tracks)
    doc.comp(root, 'cc.Animation', playOnLoad=True, _clips=[{'__uuid__': c}], _defaultClip={'__uuid__': c})


def project():
    os.makedirs(ROOT, exist_ok=True)
    write_json(f'{ROOT}/package.json', {'name': 'probe', 'uuid': uid('project'), 'creator': {'version': '3.8.8'}, 'version': '1.0.0'})
    write_json(f'{ROOT}/tsconfig.json', {'extends': './temp/tsconfig.cocos.json', 'compilerOptions': {'strict': False}})
    T = '/c/ProgramData/cocos/editors/Creator/3.8.8/resources/templates/empty-2d'
    eng = json.load(open('C:' + T[2:] + '/settings/v2/packages/engine.json', encoding='utf-8'))
    cfg = eng['modules']['configs']['defaultConfig']
    for k in ('3d', 'skeletal-animation'):
        cfg['cache'][k] = {'_value': True}
    cfg['cache']['sorting-2d'] = {'_value': True}
    cfg['cache']['render-pipeline'] = {'_option': 'custom-pipeline'}
    cfg['includeModules'] = [m for m in cfg['includeModules'] if m != 'legacy-pipeline']
    if 'custom-pipeline' not in cfg['includeModules']:
        cfg['includeModules'].append('custom-pipeline')
    for k in ('3d', 'skeletal-animation', 'sorting-2d'):
        if k not in cfg['includeModules']:
            cfg['includeModules'].append(k)
    write_json(f'{ROOT}/settings/v2/packages/engine.json', eng)
    write_json(f'{ROOT}/settings/v2/packages/project.json', {'general': {'designResolution': {'width': 960, 'height': 640, 'fitWidth': False, 'fitHeight': True}}})
    write_json(f'{ROOT}/profiles/v2/packages/scene.json', {'gizmos-infos': {'is2D': True}})
    meta(f'{ROOT}/assets', 'directory', uid('assets'), ver='1.2.0')
    os.makedirs(f'{ROOT}/assets/img', exist_ok=True)
    meta(f'{ROOT}/assets/img', 'directory', uid('assets/img'), ver='1.2.0')
    sid = scene('p1', p1)
    scenes = [{'url': 'db://assets/p1.scene', 'uuid': sid}]
    ids = gltf_ids()
    if ids:
        for name, sorting in (('p2', True), ('p2b', False)):
            s2 = scene(name, lambda doc, canvas, sorting=sorting: p2(doc, canvas, ids, sorting))
            scenes.append({'url': f'db://assets/{name}.scene', 'uuid': s2})
    base = cfg['includeModules']
    for fname, out, pipeline in (('build.json', 'web-desktop', 'custom-pipeline'), ('build-legacy.json', 'web-legacy', 'legacy-pipeline')):
        mods = [m for m in base if m not in ('custom-pipeline', 'legacy-pipeline')] + [pipeline]
        write_json(f'{ROOT}/{fname}', {
            'platform': 'web-desktop', 'debug': True, 'startScene': sid, 'scenes': scenes, 'includeModules': mods,
            'outputName': out, 'buildPath': 'project://build', 'name': 'probe', 'sourceMaps': False, 'useSplashScreen': False,
            'md5Cache': False, 'skipCompressTexture': True,
        })
    print('scene', sid)


if __name__ == '__main__':
    project()
