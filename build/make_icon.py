#!/usr/bin/env python3
"""Render the AgentDeck app icon: dark rounded square, faint 3-column deck
backdrop, bold blue terminal prompt (❯) + cursor as the hero mark."""
from PIL import Image, ImageDraw

S = 1024
SS = S * 4  # supersample for crisp edges, downscale at the end
img = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def sc(v):  # scale a 1024-space value into supersampled space
    return int(round(v * 4))

BLUE = (29, 155, 240, 255)      # #1d9bf0 app accent
BLUE_DIM = (29, 155, 240, 90)

# --- body: rounded square with a vertical dark gradient ---
margin = 64
radius = 205
body = (sc(margin), sc(margin), sc(S - margin), sc(S - margin))

# gradient strip image, then mask to the rounded rect
grad = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top = (38, 44, 54)   # #262c36
bot = (9, 11, 15)    # #090b0f
for y in range(SS):
    t = y / (SS - 1)
    r = int(top[0] * (1 - t) + bot[0] * t)
    g = int(top[1] * (1 - t) + bot[1] * t)
    b = int(top[2] * (1 - t) + bot[2] * t)
    gd.line([(0, y), (SS, y)], fill=(r, g, b, 255))

mask = Image.new("L", (SS, SS), 0)
ImageDraw.Draw(mask).rounded_rectangle(body, radius=sc(radius), fill=255)
img.paste(grad, (0, 0), mask)

# subtle top sheen
sheen = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
ImageDraw.Draw(sheen).rounded_rectangle(
    (sc(margin), sc(margin), sc(S - margin), sc(margin + 230)),
    radius=sc(radius), fill=(255, 255, 255, 16))
img.alpha_composite(Image.composite(sheen, Image.new("RGBA", (SS, SS), (0, 0, 0, 0)), mask))

# hairline inner border for definition
ImageDraw.Draw(img).rounded_rectangle(
    body, radius=sc(radius), outline=(255, 255, 255, 28), width=sc(3))

# --- 3-column deck backdrop (opaque, subtle, colored headers) ---
col_top, col_bot = 250, S - 250
cl, cr = 175, S - 175
gap = 34
colw = (cr - cl - 2 * gap) / 3
PANEL = (24, 30, 39, 255)        # #181e27, a touch lighter than the body
PANEL_BD = (46, 55, 67, 255)     # #2e3743 edge
HEAD_GRAY = (58, 67, 79, 255)    # #3a434f inactive header
for i in range(3):
    x0 = cl + i * (colw + gap)
    x1 = x0 + colw
    panel = (sc(x0), sc(col_top), sc(x1), sc(col_bot))
    ImageDraw.Draw(img).rounded_rectangle(
        panel, radius=sc(46), fill=PANEL, outline=PANEL_BD, width=sc(3))
    # column header strip: first one blue (active), others gray
    head = (sc(x0), sc(col_top), sc(x1), sc(col_top + 64))
    hmask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(hmask).rounded_rectangle(panel, radius=sc(46), fill=255)
    strip = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    ImageDraw.Draw(strip).rectangle(head, fill=(BLUE if i == 0 else HEAD_GRAY))
    img.alpha_composite(Image.composite(strip, Image.new("RGBA", (SS, SS), (0, 0, 0, 0)), hmask))

# --- hero: blue terminal prompt ❯ + cursor block, centered over the deck ---
cx, cy = 470, 555
arm = 150
w = sc(80)
p_top = (sc(cx - arm + 30), sc(cy - arm))
p_mid = (sc(cx + 70), sc(cy))
p_bot = (sc(cx - arm + 30), sc(cy + arm))
ImageDraw.Draw(img).line([p_top, p_mid], fill=BLUE, width=w, joint="curve")
ImageDraw.Draw(img).line([p_mid, p_bot], fill=BLUE, width=w, joint="curve")
# round the three ends
for (px, py) in (p_top, p_mid, p_bot):
    rr = w // 2
    ImageDraw.Draw(img).ellipse((px - rr, py - rr, px + rr, py + rr), fill=BLUE)

# cursor block to the right
cu_x0, cu_y0 = cx + 150, cy + 66
cu_x1, cu_y1 = cu_x0 + 200, cu_y0 + 84
ImageDraw.Draw(img).rounded_rectangle(
    (sc(cu_x0), sc(cu_y0), sc(cu_x1), sc(cu_y1)), radius=sc(14), fill=(231, 233, 234, 255))

# downscale
out = img.resize((S, S), Image.LANCZOS)
out.save("/tmp/agentdeck_icon_1024.png")
print("wrote /tmp/agentdeck_icon_1024.png")
