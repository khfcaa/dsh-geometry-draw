/** 把演示图拼成一张带标题的图集 */
import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 解释器按「环境变量 → python3 → python」找；只影响这张维护者用的图集，不影响插件本体。
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const demoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo');
const out = `${demoDir}/gallery.png`;

const script = `
import os
from PIL import Image, ImageDraw, ImageFont

base = r"${demoDir}"
items = [
    ("01-boolean-gradient", "boolean difference + linear gradient"),
    ("02-offset-ring-pattern", "contour offset ring + pattern fill"),
    ("03-repeat-mirror", "rotational array + mirror (12 arms)"),
    ("04-polar-rose", "polar rose r=5cos(3t) + radial gradient"),
    ("05-parametric-lissajous", "parametric Lissajous (self-intersecting)"),
    ("06-annotation", "annotated construction"),
]
cell = 340
pad = 18
label_h = 26
cols = 3
rows = 2
W = cols * (cell + pad) + pad
H = rows * (cell + pad + label_h) + pad
canvas = Image.new("RGB", (W, H), (255, 255, 255))
draw = ImageDraw.Draw(canvas)

font = None
for candidate in [r"C:\\Windows\\Fonts\\msyh.ttc", r"C:\\Windows\\Fonts\\arial.ttf"]:
    if os.path.exists(candidate):
        try:
            font = ImageFont.truetype(candidate, 14)
            break
        except Exception:
            pass
if font is None:
    font = ImageFont.load_default()

missing = []
for index, (name, label) in enumerate(items):
    path = os.path.join(base, name + ".png")
    col = index % cols
    row = index // cols
    x = pad + col * (cell + pad)
    y = pad + row * (cell + pad + label_h)
    if not os.path.exists(path):
        missing.append(name)
        continue
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((cell, cell), Image.LANCZOS)
        ox = x + (cell - im.width) // 2
        oy = y + (cell - im.height) // 2
        canvas.paste(im, (ox, oy))
    draw.rectangle([x, y, x + cell, y + cell], outline=(226, 232, 240), width=1)
    draw.text((x + 2, y + cell + 5), label, fill=(51, 65, 85), font=font)

canvas.save(r"${out}")
print("saved", r"${out}", canvas.size, "missing:", missing)
`;

const result = spawnSync(python, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) {
	console.log('图集生成失败');
	process.exit(1);
}
mkdirSync(demoDir, { recursive: true });
console.log('存在:', existsSync(out));
