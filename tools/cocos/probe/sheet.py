"""采集端存下来的帧拼成一张对照图:每个骨架一张,行 = 动画,列 = 时刻。按内容裁边后缩放。"""
import glob
import os
import sys

from PIL import Image

R = 'C:/Users/zhe.huang/AppData/Local/Temp/agc/renders'  # cocos-collect 的 --dir
OUT = os.path.dirname(os.path.abspath(__file__))


def content_box(im):
    px = im.load()
    bg = px[2, 2]
    pts = [(x, y) for x in range(0, im.width, 3) for y in range(0, im.height, 3) if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > 40]
    if not pts:
        return (0, 0, im.width, im.height)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (max(min(xs) - 6, 0), max(min(ys) - 6, 0), min(max(xs) + 6, im.width), min(max(ys) + 6, im.height))


def sheet(name, cell):
    files = sorted(glob.glob(f'{R}/{name}_*.png'))
    clips = {}
    for f in files:
        stem = os.path.basename(f)[len(name) + 1:-4]
        if '_' not in stem or not stem.rsplit('_', 1)[1].isdigit():
            continue  # 不是 <动画>_<序号> 的(调试时存的单张)跳过
        clip, idx = stem.rsplit('_', 1)
        clips.setdefault(clip, []).append((int(idx), f))
    rows = [sorted(v) for _, v in sorted(clips.items())]
    cols = max(len(r) for r in rows)
    # 同一个骨架所有帧用同一个裁切框,位置变化才看得出来
    ims = [[Image.open(f).convert('RGB') for _, f in r] for r in rows]
    boxes = [content_box(im) for r in ims for im in r]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    out = Image.new('RGB', (cell * cols, cell * len(rows)), (40, 40, 40))
    for ri, r in enumerate(ims):
        for ci, im in enumerate(r):
            t = im.crop(box)
            t.thumbnail((cell, cell))
            out.paste(t, (ci * cell, ri * cell))
    p = f'{OUT}/sheet_{name}.png'
    out.save(p)
    print(p, [k for k in sorted(clips)], 'box', box)


for n in sys.argv[1:]:
    sheet(n, 300)
