"""
M13 icon generator — pure Pillow, no Cairo required.
Draws: dark circle background, ice-blue zodiac ring, gold Circle of Fifths,
       gold star field, two-tone M, crescent moon.
Run: python3 build/generate_icon.py
"""

import math, os
from PIL import Image, ImageDraw, ImageFilter

SIZE   = 1024
CX, CY = SIZE // 2, SIZE // 2
R      = SIZE // 2       # outer radius of the whole icon disc

# ── Colours ──────────────────────────────────────────────────────────────────
BG_DARK      = (6,   6,  16, 255)   # #060610
BG_MID       = (12, 12,  32, 255)   # deep navy, vignette centre
ZODIAC_COL   = (160, 210, 240, 180) # ice blue, semi-transparent
GOLD_BRIGHT  = (240, 192,  64, 255) # #f0c040
GOLD_DIM     = (200, 152,  32, 220) # #c89820
GOLD_RING    = (220, 175,  50, 160) # circle of fifths ring
STAR_COL     = (240, 200,  80, 200) # warm gold stars
MOON_FILL    = (248, 230, 160, 255) # pale gold moon
MOON_SHADOW  = (6,   6,  22, 255)   # background-matching shadow

# ── Helper: draw a filled anti-aliased circle on a layer ────────────────────
def circle_mask(draw, cx, cy, r, fill):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def aa_disc(size, cx, cy, r, fill, inner_r=0):
    """RGBA layer with an anti-aliased (annular) disc at 2× then downscaled."""
    s = size * 2
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d   = ImageDraw.Draw(img)
    d.ellipse([cx*2 - r*2, cy*2 - r*2, cx*2 + r*2, cy*2 + r*2], fill=fill)
    if inner_r:
        d.ellipse([cx*2 - inner_r*2, cy*2 - inner_r*2, cx*2 + inner_r*2, cy*2 + inner_r*2],
                  fill=(0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


def aa_arc(size, cx, cy, r, t, start_deg, end_deg, fill):
    """Anti-aliased arc (ring segment) via 2× supersample."""
    s = size * 2
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d   = ImageDraw.Draw(img)
    box = [cx*2 - r*2, cy*2 - r*2, cx*2 + r*2, cy*2 + r*2]
    d.arc(box, start=start_deg, end=end_deg, fill=fill, width=t*2)
    return img.resize((size, size), Image.LANCZOS)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Base canvas — RGBA
# ═══════════════════════════════════════════════════════════════════════════════
canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# Circular mask for the whole icon
disc_mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(disc_mask).ellipse([0, 0, SIZE - 1, SIZE - 1], fill=255)

# Background gradient: dark centre → slightly lighter edge (painted at 2×)
bg = Image.new('RGBA', (SIZE, SIZE), BG_DARK)
# Radial vignette: make edges slightly lighter blue
vignette = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
vd = ImageDraw.Draw(vignette)
for step, (r_frac, a) in enumerate([(1.0, 0), (0.7, 0), (0.0, 40)]):
    rr = int(R * r_frac)
    alpha_col = (18, 18, 55, a)
    if rr > 0:
        vd.ellipse([CX - rr, CY - rr, CX + rr, CY + rr], fill=alpha_col)
bg = Image.alpha_composite(bg, vignette)
bg.putalpha(disc_mask)
canvas = Image.alpha_composite(canvas, bg)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Stars — scattered gold dots, denser toward the rim
# ═══════════════════════════════════════════════════════════════════════════════
import random
random.seed(42)
star_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(star_layer)
for _ in range(320):
    angle = random.uniform(0, 2 * math.pi)
    # Bias toward outer 40-95% of radius
    dist  = R * random.uniform(0.40, 0.95)
    sx    = int(CX + dist * math.cos(angle))
    sy    = int(CY + dist * math.sin(angle))
    r_dot = random.choice([1, 1, 1, 2])
    alpha = random.randint(80, 200)
    sd.ellipse([sx - r_dot, sy - r_dot, sx + r_dot, sy + r_dot],
               fill=(*STAR_COL[:3], alpha))
canvas = Image.alpha_composite(canvas, star_layer)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Circle of Fifths — 12 concentric arcs (gold ring with gap between each key)
# ═══════════════════════════════════════════════════════════════════════════════
cof_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
COF_R_OUT = int(R * 0.80)
COF_R_IN  = int(R * 0.68)
COF_T     = COF_R_OUT - COF_R_IN
GAP       = 4  # degrees gap between segments

for i in range(12):
    seg_start = i * 30 + GAP / 2 - 90
    seg_end   = (i + 1) * 30 - GAP / 2 - 90
    # Alternate brightness slightly
    brightness = 1.0 if i % 2 == 0 else 0.75
    col = tuple(int(c * brightness) for c in GOLD_RING[:3]) + (GOLD_RING[3],)
    arc = aa_arc(SIZE, CX, CY, (COF_R_OUT + COF_R_IN) // 2, COF_T,
                 seg_start, seg_end, col)
    cof_layer = Image.alpha_composite(cof_layer, arc)

canvas = Image.alpha_composite(canvas, cof_layer)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Zodiac ring — thin ice-blue continuous ring with 12 tick marks
# ═══════════════════════════════════════════════════════════════════════════════
zod_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
ZOD_R = int(R * 0.87)
ZOD_T = 3
zd = ImageDraw.Draw(zod_layer)
# Full thin ring
zod_ring = aa_disc(SIZE, CX, CY, ZOD_R, ZODIAC_COL, ZOD_R - ZOD_T)
zod_layer = Image.alpha_composite(zod_layer, zod_ring)
# 12 tick marks
zd2 = ImageDraw.Draw(zod_layer)
for i in range(12):
    angle = math.radians(i * 30 - 90)
    r_inner = ZOD_R - 12
    r_outer = ZOD_R + 12
    x1 = int(CX + r_inner * math.cos(angle))
    y1 = int(CY + r_inner * math.sin(angle))
    x2 = int(CX + r_outer * math.cos(angle))
    y2 = int(CY + r_outer * math.sin(angle))
    zd2.line([x1, y1, x2, y2], fill=ZODIAC_COL, width=2)
# 36 minor ticks
for i in range(36):
    angle = math.radians(i * 10 - 90)
    r_inner = ZOD_R - 5
    r_outer = ZOD_R + 5
    x1 = int(CX + r_inner * math.cos(angle))
    y1 = int(CY + r_inner * math.sin(angle))
    x2 = int(CX + r_outer * math.cos(angle))
    y2 = int(CY + r_outer * math.sin(angle))
    zd2.line([x1, y1, x2, y2], fill=(*ZODIAC_COL[:3], 90), width=1)
canvas = Image.alpha_composite(canvas, zod_layer)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Two-tone gold M — verticals bright #f0c040, diagonals dimmer #c89820
# ═══════════════════════════════════════════════════════════════════════════════
m_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# M geometry: draw at 2× for AA then scale down
S2 = SIZE * 2
m2 = Image.new('RGBA', (S2, S2), (0, 0, 0, 0))
md = ImageDraw.Draw(m2)

# M bounding box (within CoF inner ring)
M_TOP    = int(CY * 2 - S2 * 0.285)
M_BOT    = int(CY * 2 + S2 * 0.285)
M_LEFT   = int(CX * 2 - S2 * 0.195)
M_RIGHT  = int(CX * 2 + S2 * 0.195)
M_MID_Y  = int(CY * 2 + S2 * 0.055)  # bottom of V notch
BAR_W    = int(S2 * 0.062)            # stroke width

# Left vertical (bright gold)
md.rectangle([M_LEFT, M_TOP, M_LEFT + BAR_W, M_BOT],
             fill=(*GOLD_BRIGHT[:3], 255))
# Right vertical (bright gold)
md.rectangle([M_RIGHT - BAR_W, M_TOP, M_RIGHT, M_BOT],
             fill=(*GOLD_BRIGHT[:3], 255))

# Left diagonal (dim gold) — polygon
CX2, CY2 = CX * 2, CY * 2
mid_x = CX2
md.polygon([
    M_LEFT,              M_TOP,
    M_LEFT + BAR_W,      M_TOP,
    mid_x + BAR_W // 2,  M_MID_Y,
    mid_x - BAR_W // 2,  M_MID_Y,
], fill=(*GOLD_DIM[:3], 220))
# Right diagonal (dim gold)
md.polygon([
    M_RIGHT,             M_TOP,
    M_RIGHT - BAR_W,     M_TOP,
    mid_x - BAR_W // 2,  M_MID_Y,
    mid_x + BAR_W // 2,  M_MID_Y,
], fill=(*GOLD_DIM[:3], 220))

m2_down = m2.resize((SIZE, SIZE), Image.LANCZOS)
canvas = Image.alpha_composite(canvas, m2_down)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Crescent moon — pale gold disc with background-coloured shadow disc
# ═══════════════════════════════════════════════════════════════════════════════
moon_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
MOON_R = int(R * 0.095)
# Position: upper-right, just inside the zodiac ring
moon_angle = math.radians(-38)
moon_dist  = int(R * 0.70)
MX = int(CX + moon_dist * math.cos(moon_angle))
MY = int(CY + moon_dist * math.sin(moon_angle))

moon_disc  = aa_disc(SIZE, MX, MY, MOON_R, MOON_FILL)
shadow_off = int(MOON_R * 0.52)
moon_shad  = aa_disc(SIZE, MX + shadow_off, MY - shadow_off // 3,
                     int(MOON_R * 0.82), MOON_SHADOW)
moon_layer = Image.alpha_composite(moon_layer, moon_disc)
moon_layer = Image.alpha_composite(moon_layer, moon_shad)
canvas = Image.alpha_composite(canvas, moon_layer)


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Subtle inner glow at centre + outer rim darkening
# ═══════════════════════════════════════════════════════════════════════════════
glow_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_layer)
# Centre soft glow (dark navy, so it darkens the star field under the M)
for rad, alpha in [(int(R*0.45), 120), (int(R*0.30), 90), (int(R*0.18), 60)]:
    gd.ellipse([CX - rad, CY - rad, CX + rad, CY + rad],
               fill=(4, 4, 14, alpha))
glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(40))
canvas = Image.alpha_composite(canvas, glow_layer)

# Re-apply circular clip
canvas.putalpha(disc_mask)

# ═══════════════════════════════════════════════════════════════════════════════
# 8. Save
# ═══════════════════════════════════════════════════════════════════════════════
out = canvas.convert('RGBA')
out_path = os.path.join(os.path.dirname(__file__), 'icon_1024.png')
out.save(out_path)
print(f'Saved {out_path}  ({out.size[0]}×{out.size[1]})')
