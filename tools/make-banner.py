"""
把 6 张示例图 + 标题排版成仓库头图。

为什么排版放在 Python/PIL 而不是几何 DSL 里：
  · 几何引擎的 `xRange` 是**内容范围**，画布留白由 padding 决定，世界原点并不正好
    落在像素中心；做像素级对齐会一直在跟这个偏差较劲。
  · 中文标题需要确定的字体，PIL 的 truetype 回退比把文字塞进 SVG 再交给 resvg 可控。
分工因此是：**几何归几何引擎，排版归 PIL**。这只影响头图，不影响插件任何行为。

用法：python tools/make-banner.py <assets_dir> <out_png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 860
BG = (248, 250, 252)
INK = (15, 23, 42)
MUTED = (100, 116, 139)
BORDER = (226, 232, 240)

TILES = [
    ("01-boolean-gradient", "布尔差集", "boolean difference"),
    ("02-offset-ring-pattern", "轮廓偏移环带", "contour offset"),
    ("03-repeat-mirror", "旋转阵列 + 镜像", "array + mirror"),
    ("04-polar-rose", "极坐标玫瑰线", "polar rose"),
    ("05-parametric-lissajous", "参数方程曲线", "parametric curve"),
    ("06-annotation", "几何标注", "annotation"),
]

CANVAS_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]
MONO_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(candidates, size):
    for candidate in candidates:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                continue
    return ImageFont.load_default()


def main():
    assets = sys.argv[1]
    out_path = sys.argv[2]

    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)

    title_font = load_font(MONO_FONT_CANDIDATES, 66)
    cjk_font = load_font(CANVAS_FONT_CANDIDATES, 26)
    tag_font = load_font(CANVAS_FONT_CANDIDATES, 20)
    tiny_font = load_font(CANVAS_FONT_CANDIDATES, 18)

    # ---- 标题区
    draw.text((96, 66), "dsh-geometry-draw", font=title_font, fill=INK)
    draw.text((100, 158), "自由几何绘图 · 用声明式规格画出复杂图形与填色", font=cjk_font, fill=MUTED)
    draw.text(
        (100, 200),
        "布尔运算 · 轮廓偏移 · 多轮廓孔洞 · 渐变与图案 · 参数与极坐标曲线 · 阵列与镜像 · 几何标注",
        font=tag_font, fill=(148, 163, 184),
    )

    # 标题与图集之间的分隔线
    draw.line([(100, 254), (W - 96, 254)], fill=BORDER, width=2)

    # ---- 图集：3 列 × 2 行
    cols, rows = 3, 2
    pad = 40
    cell_w = (W - 2 * pad) // cols
    cell_h = 210
    grid_top = 300
    gap = 26
    tile_side = min(cell_h, cell_w - 2 * gap)

    for index, (name, cjk_label, en_label) in enumerate(TILES):
        row, col = divmod(index, cols)
        cell_x = pad + col * cell_w
        cell_y = grid_top + row * (cell_h + gap)

        # 圆角底板：给透明背景的图形一个确定的底，浅色主题下也稳
        box = [cell_x + gap, cell_y, cell_x + gap + tile_side, cell_y + tile_side]
        draw.rounded_rectangle(box, radius=16, fill=(255, 255, 255), outline=BORDER, width=2)

        png = os.path.join(assets, name + ".png")
        if os.path.exists(png):
            with Image.open(png) as tile:
                tile = tile.convert("RGBA")
                inner = tile_side - 20
                tile.thumbnail((inner, inner), Image.LANCZOS)
                canvas.paste(
                    tile,
                    (box[0] + (tile_side - tile.width) // 2, box[1] + (tile_side - tile.height) // 2),
                    tile,
                )

        text_x = box[2] + 20
        draw.text((text_x, cell_y + 52), cjk_label, font=tag_font, fill=INK)
        draw.text((text_x, cell_y + 90), en_label, font=tiny_font, fill=(148, 163, 184))

    # ---- 页脚
    draw.text((100, H - 56), "SVG + PNG  ·  数学坐标（y 向上）  ·  零运行时依赖  ·  MIT", font=tiny_font, fill=(148, 163, 184))

    canvas.save(out_path)
    print("saved", out_path, canvas.size)


if __name__ == "__main__":
    main()
