"""Remove the outer transparent padding from the app icon and emit
full-bleed master + multi-size ICO for Windows packaging.

- crop to alpha bounding box, square it, add a tiny uniform breathing margin
- write resources/icon.png (1024 master), resources/icon-512/256/128/64/32.png
- write resources/icon.ico (16..256) for electron-builder win target
- backup the original to <repo root>/icon-original.png
"""
from PIL import Image
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "resources", "icon.png")
BACKUP = os.path.join(ROOT, "icon-original.png")
MARGIN_RATIO = 0.02  # small optical breathing room after tight crop

img = Image.open(SRC).convert("RGBA")
alpha = img.getchannel("A")
bbox = alpha.getbbox()  # (left, top, right, bottom)
print("original:", img.size, "content bbox:", bbox)

# 1) tight crop
crop = img.crop(bbox)
w, h = crop.size
print("after crop:", crop.size)

# 2) square canvas (center)
side = max(w, h)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(crop, ((side - w) // 2, (side - h) // 2))

# 3) uniform breathing margin
pad = int(side * MARGIN_RATIO)
final = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
final.paste(square, (pad, pad))
print("full-bleed master:", final.size, "margin:", pad)

# backup original once
if not os.path.exists(BACKUP):
    img.save(BACKUP)
    print("backup saved:", BACKUP)

# 4) write master + common sizes
final.save(SRC)
print("wrote", SRC)
for s in (512, 256, 128, 64, 48, 32, 16):
    out = os.path.join(ROOT, "resources", f"icon-{s}.png")
    final.resize((s, s), Image.LANCZOS).save(out)
    print("wrote", out)

# 5) multi-size ICO for Windows
ico_path = os.path.join(ROOT, "resources", "icon.ico")
final.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", ico_path)

# 6) tray-optimized: 32px with slight padding baked (tray icons look better with padding)
tray = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
inner = final.resize((26, 26), Image.LANCZOS)
tray.paste(inner, (3, 3))
tray.save(os.path.join(ROOT, "resources", "tray.png"))
print("wrote tray.png")
