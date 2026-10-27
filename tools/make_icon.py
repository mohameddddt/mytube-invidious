"""Generate assets/mytube.ico: an amber rounded square with a dark play triangle (build-time only, needs Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024  # draw large, then let Pillow downsample into the icon sizes
AMBER, INK = (245, 165, 36, 255), (29, 19, 0, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=int(SIZE * 0.24), fill=AMBER)
# play triangle, nudged right so it looks optically centred
cx, cy, h = SIZE * 0.53, SIZE * 0.5, SIZE * 0.3
draw.polygon([(cx - h * 0.78, cy - h), (cx - h * 0.78, cy + h), (cx + h * 1.02, cy)], fill=INK)

out = Path(__file__).resolve().parent.parent / "assets" / "mytube.ico"
out.parent.mkdir(exist_ok=True)
img.save(out, format="ICO", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
print("wrote", out)
