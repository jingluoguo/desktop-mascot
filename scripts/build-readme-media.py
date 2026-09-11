#!/usr/bin/env python3
"""生成 README 与落地页用的品牌素材。

产出（都写到 landing/media/，因为 GitHub Pages 只发布 landing/ 目录）：
  characters.png  五个内置角色横排图，透明背景，README 首屏用
  demo.gif        幽灵角色的表情循环动图，深色卡片背景
  og.png          1200x630 社交分享卡，落地页 og:image 用

素材由 lively-mascot 引擎在无头 Chrome 里渲染，不是真机截图，也没有录屏。
需要：Chrome + Pillow。运行：python3 scripts/build-readme-media.py

渲染要点（踩过的坑）：
  - HTML 与 lively-mascot 的 css/js 必须放在同一个目录，Chrome 的 file:// 不允许
    加载父目录里的子资源会失败，所以这里用临时目录而不是仓库内的相对路径。
  - --default-background-color=00000000 才能拿到真正的透明通道。
  - --virtual-time-budget 让动画按确定的时间推进，同一参数每次渲染结果一致。
  - 逐帧裁剪必须用所有帧的并集 bbox，否则角色会在 GIF 里来回跳。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "landing" / "media"
DIST = ROOT / "node_modules" / "lively-mascot" / "dist"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

RENDER_SCALE = 3
OUT_SCALE = 2 / 3
CARD = "#071715"
CARD_RADIUS = 28

CHARACTERS = ["ghost", "sprout", "cat", "robot", "jelly"]

THEMES = {
    "ghost": ("#bdeef2", "#23434d", "#a9d9ff"),
    "sprout": ("#48ff42", "#080808", "#ff9fb6"),
    "cat": ("#3d4852", "#131a20", "#eeb3c1"),
    "robot": ("#6f879b", "#162332", "#74e5ff"),
    "jelly": ("#f29cc2", "#5a243e", "#ffe0a8"),
}

PAGE = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./lively-mascot.min.css" />
    <style>
      html, body { margin: 0; background: transparent; }
      body { display: flex; align-items: center; justify-content: center; gap: 10px; height: 100vh; overflow: hidden; }
      .m { flex: none; }
    </style>
  </head>
  <body>
    <script src="./lively-mascot.min.js"></script>
    <script>
      const p = new URLSearchParams(location.search);
      const api = window.LivelyMascot;
      const themes = {
        ghost: { body: "#bdeef2", outline: "#23434d", accent: "#a9d9ff" },
        sprout: { body: "#48ff42", outline: "#080808", accent: "#ff9fb6" },
        cat: { body: "#3d4852", outline: "#131a20", accent: "#eeb3c1" },
        robot: { body: "#6f879b", outline: "#162332", accent: "#74e5ff" },
        jelly: { body: "#f29cc2", outline: "#5a243e", accent: "#ffe0a8" },
      };
      const types = (p.get("types") || "ghost").split(",");
      const size = Number(p.get("size")) || 150;
      const emotions = (p.get("emotion") || "02").split(",");
      types.forEach((type, index) => {
        const host = document.createElement("div");
        host.className = "m";
        document.body.appendChild(host);
        const theme = themes[type] || themes.ghost;
        const mascot = api.createMascot(host, {
          type,
          size,
          color: theme.body,
          outline: theme.outline,
          accent: theme.accent,
          viewMode: "3d",
          outlineVisible: true,
          followCursor: false,
          animated: p.get("animated") === "1",
          hopInterval: p.get("hop") === "1" ? [900, 1400] : null,
        });
        mascot.setEmotion(emotions[index] || emotions[0]);
      });
      document.documentElement.dataset.ready = "1";
    </script>
  </body>
</html>
"""


def prepare_workdir() -> Path:
    for name in ("lively-mascot.min.css", "lively-mascot.min.js"):
        if not (DIST / name).exists():
            sys.exit(f"缺少 {DIST / name}，请先 yarn install")
    workdir = Path(tempfile.mkdtemp(prefix="dm-media-"))
    (workdir / "index.html").write_text(PAGE, encoding="utf-8")
    for name in ("lively-mascot.min.css", "lively-mascot.min.js"):
        shutil.copy(DIST / name, workdir / name)
    return workdir


def shot(workdir: Path, query: str, out: Path, width: int, height: int, vt: int) -> Image.Image:
    subprocess.run(
        [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--default-background-color=00000000",
            f"--force-device-scale-factor={RENDER_SCALE}",
            f"--window-size={width},{height}",
            f"--virtual-time-budget={vt}",
            f"--screenshot={out}",
            f"file://{workdir}/index.html?{query}",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return Image.open(out).convert("RGBA")


def union_bbox(frames: list[Image.Image]) -> tuple[int, int, int, int]:
    boxes = [f.getchannel("A").getbbox() for f in frames]
    boxes = [b for b in boxes if b]
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def downscale(image: Image.Image) -> Image.Image:
    return image.resize(
        (round(image.width * OUT_SCALE), round(image.height * OUT_SCALE)), Image.LANCZOS
    )


def card(frame: Image.Image, pad: int, radius: int) -> Image.Image:
    """把透明底的帧放到一张深色圆角卡片上。"""
    base = Image.new("RGBA", (frame.width + pad * 2, frame.height + pad * 2), (0, 0, 0, 0))
    mask = Image.new("L", (base.width * 4, base.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=radius * 4, fill=255
    )
    mask = mask.resize(base.size, Image.LANCZOS)
    base.paste(Image.new("RGBA", base.size, CARD), (0, 0), mask)
    base.alpha_composite(frame, (pad, pad))
    return base


def build_characters(workdir: Path) -> None:
    tmp = workdir / "characters.png"
    frame = shot(
        workdir,
        f"types={','.join(CHARACTERS)}&size=150&emotion=10&animated=0",
        tmp,
        1800,
        620,
        1600,
    )
    box = union_bbox([frame])
    pad = 24 * RENDER_SCALE
    crop = Image.new("RGBA", (box[2] - box[0] + pad * 2, box[3] - box[1] + pad * 2), (0, 0, 0, 0))
    crop.alpha_composite(frame.crop(box), (pad, pad))
    out = downscale(crop)
    out.save(MEDIA / "characters.png", optimize=True)
    print("characters.png", out.size)


def build_demo(workdir: Path) -> None:
    """表情循环动图。

    每帧一个表情、交替两个采样时刻让身体位置有细微位移。刻意不做逐帧补间：
    引擎的待机动画幅度很小（帧间均差约 1/255），补间只会让 GIF 变大而不变好看，
    真正吸引眼睛的是表情本身的切换。
    """
    sequence = ["00", "02", "11", "10", "16", "38", "15", "19"]
    frames: list[Image.Image] = []
    for index, emotion in enumerate(sequence):
        frames.append(
            shot(
                workdir,
                f"types=ghost&size=130&emotion={emotion}&animated=1&hop=1",
                workdir / f"gif-{index:02d}.png",
                520,
                560,
                300 if index % 2 == 0 else 620,
            )
        )

    box = union_bbox(frames)
    pad = 26 * RENDER_SCALE
    size = (box[2] - box[0] + pad * 2, box[3] - box[1] + pad * 2)
    cards = []
    for frame in frames:
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        canvas.alpha_composite(frame.crop(box), (pad, pad))
        cards.append(downscale(card(canvas, 20 * RENDER_SCALE, CARD_RADIUS * RENDER_SCALE)))

    combined = Image.new("RGB", (cards[0].width, cards[0].height * len(cards)))
    for index, item in enumerate(cards):
        combined.paste(item.convert("RGB"), (0, index * item.height))
    palette = combined.quantize(colors=255, method=Image.MEDIANCUT)
    quantized = [item.convert("RGB").quantize(palette=palette) for item in cards]
    quantized[0].save(
        MEDIA / "demo.gif",
        save_all=True,
        append_images=quantized[1:],
        duration=300,
        loop=0,
        disposal=2,
        optimize=True,
    )
    print("demo.gif", cards[0].size, len(quantized), "frames")


def build_og() -> None:
    characters = Image.open(MEDIA / "characters.png").convert("RGBA")
    canvas = Image.new("RGBA", (1200, 630), CARD)
    target_w = 1040
    scaled = characters.resize(
        (target_w, round(characters.height * target_w / characters.width)), Image.LANCZOS
    )
    canvas.alpha_composite(scaled, ((1200 - scaled.width) // 2, (630 - scaled.height) // 2))
    canvas.convert("RGB").save(MEDIA / "og.png", optimize=True)
    print("og.png", canvas.size)


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    workdir = prepare_workdir()
    try:
        build_characters(workdir)
        build_demo(workdir)
        build_og()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
