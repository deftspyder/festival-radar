#!/usr/bin/env python3
"""Make a share page and preview image for every festival and show in festivals.json.

Texted links like https://deftspyder.github.io/festival-radar/f/<id>.html show that festival's
name, dates and picture in the message preview, then send the visitor on to its card on the site.

Run from the repo root after festivals.json changes:  python3 tools/share_pages.py
Needs Pillow (pip install pillow). Writes f/<id>.html and f/img/<id>.jpg; unchanged files are left alone.
Pages for festivals that have left the list are kept so old texted links still work.
"""
import hashlib, html, io, json, math, os, re, sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SITE = "https://deftspyder.github.io/festival-radar/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "tools", "fonts")
OUT = os.path.join(ROOT, "f")
IMG = os.path.join(OUT, "img")
W, H = 1200, 630
BG, PINK, VIOLET, CYAN, ORANGE, GOLD = (18, 10, 36), (255, 61, 154), (168, 107, 255), (41, 211, 245), (255, 154, 74), (255, 204, 77)
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,150}$")
STATUS_COLORS = {"On sale": (52, 211, 153), "Presale soon": ORANGE, "Waitlist": PINK, "Watch": CYAN}


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def wrap(draw, text, fnt, width, max_lines):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines if len(lines) <= max_lines else None


def fit_title(draw, text, width):
    for size in (92, 84, 76, 68, 60, 54, 48, 42):
        f = font("Audiowide-Regular.ttf", size)
        lines = wrap(draw, text, f, width, 3 if size <= 60 else 2)
        if lines and all(draw.textlength(l, font=f) <= width for l in lines):
            return f, lines, size
    f = font("Audiowide-Regular.ttf", 42)
    lines = wrap(draw, text, f, width, 99) or [text]
    return f, lines[:3], 42


def background():
    img = Image.new("RGB", (W, H), BG)
    glow = Image.new("RGB", (W, H), BG)
    g = ImageDraw.Draw(glow)
    g.ellipse((-260, 330, 520, 980), fill=(120, 30, 110))
    g.ellipse((760, -300, 1500, 360), fill=(40, 70, 150))
    g.ellipse((640, 380, 1280, 900), fill=(110, 50, 170))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.blend(img, glow, 0.85)
    d = ImageDraw.Draw(img, "RGBA")
    # synthwave grid along the bottom
    hy = 470
    for i in range(1, 9):
        y = hy + (H - hy) * (i / 8) ** 1.8
        d.line((0, y, W, y), fill=VIOLET + (60,), width=2)
    for i in range(-12, 13):
        d.line((W / 2 + i * 40, hy, W / 2 + i * 190, H), fill=VIOLET + (50,), width=2)
    # radar rings and sweep, right side
    cx, cy = 1030, 205
    for r in (70, 130, 190):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=CYAN + (70,), width=3)
    sweep = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    s = ImageDraw.Draw(sweep)
    for k in range(36):
        a0, a1 = -90 + k * 1.7, -90 + (k + 1) * 1.7 + 0.5
        s.pieslice((cx - 190, cy - 190, cx + 190, cy + 190), a0, a1, fill=VIOLET + (int(10 + k * 3.2),))
    img.paste(sweep, (0, 0), sweep)
    d = ImageDraw.Draw(img, "RGBA")
    a = math.radians(-90 + 36 * 1.7)
    d.line((cx, cy, cx + 190 * math.cos(a), cy + 190 * math.sin(a)), fill=(255, 255, 255, 220), width=4)
    bx, by = cx + 115 * math.cos(math.radians(-60)), cy + 115 * math.sin(math.radians(-60))
    d.ellipse((bx - 9, by - 9, bx + 9, by + 9), fill=(255, 255, 255, 240))
    d.ellipse((cx - 120, cy + 60, cx - 106, cy + 74), fill=CYAN + (230,))
    return img


BASE = None


def make_image(f):
    global BASE
    if BASE is None:
        BASE = background()
    img = BASE.copy()
    d = ImageDraw.Draw(img, "RGBA")
    x, maxw = 70, 760
    try:
        logo = Image.open(os.path.join(ROOT, "icons", "icon-192.png")).convert("RGBA").resize((64, 64), Image.LANCZOS)
        img.paste(logo, (x, 56), logo)
        d.text((x + 82, 74), "FESTIVAL RADAR", font=font("Audiowide-Regular.ttf", 30), fill=(255, 255, 255))
    except OSError:
        d.text((x, 70), "FESTIVAL RADAR", font=font("Audiowide-Regular.ttf", 30), fill=(255, 255, 255))
    tf, lines, size = fit_title(d, f.get("festival", ""), maxw)
    lh = int(size * 1.12)
    y = 175 if len(lines) < 3 else 160
    for line in lines:
        d.text((x + 3, y + 3), line, font=tf, fill=PINK + (150,))
        d.text((x, y), line, font=tf, fill=(255, 255, 255))
        y += lh
    y += 14
    mf = font("Figtree-Bold.ttf", 36)
    parts = [p for p in (f.get("dates", ""), f.get("city", "")) if p]
    meta = " · ".join(parts)
    rows = [meta] if d.textlength(meta, font=mf) <= 1060 or len(parts) < 2 else parts
    for row in rows:
        while row and d.textlength(row, font=mf) > 1060 and len(row) > 10:
            row = row[:-2].rstrip() + "…"
        d.text((x, y), row, font=mf, fill=GOLD)
        y += 46
    y += 12
    status = f.get("status", "")
    if status:
        sf = font("Figtree-Bold.ttf", 26)
        col = STATUS_COLORS.get(status, CYAN)
        tw = d.textlength(status, font=sf)
        d.rounded_rectangle((x, y, x + tw + 36, y + 44), radius=22, outline=col, width=3, fill=BG + (170,))
        d.text((x + 18, y + 7), status, font=sf, fill=col)
    d.text((x, H - 62), "See who's going and get presale alerts", font=font("Figtree-Medium.ttf", 28), fill=(255, 255, 255, 215))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80, optimize=True, progressive=True)
    return buf.getvalue()


def esc(s):
    return html.escape(str(s or ""), quote=True)


def make_page(f, img_ver):
    fid = f["id"]
    name = f.get("festival", "")
    meta = " · ".join(p for p in (f.get("dates", ""), f.get("city", "")) if p)
    arts = f.get("artists", "") or ""
    lineup = ""
    if arts and arts != "Lineup TBA":
        parts = [a.strip() for a in arts.split(",") if a.strip()]
        lineup = "With " + ", ".join(parts[:5]) + (" and more" if len(parts) > 5 else "") + ". "
    desc = (meta + ". " if meta else "") + lineup + "See who's going and get presale alerts on Festival Radar."
    page = SITE + "f/" + fid + ".html"
    img = SITE + "f/img/" + fid + ".jpg?v=" + img_ver
    card = "../?card=" + fid
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(name)} on Festival Radar</title>
<meta name="description" content="{esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Festival Radar">
<meta property="og:title" content="{esc(name)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(page)}">
<meta property="og:image" content="{esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(name)}, {esc(meta)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(name)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{esc(img)}">
<meta name="theme-color" content="#120a24">
<link rel="icon" href="../icons/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="{esc(page)}">
<style>
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #120a24; color: #f3ecff; font: 16px/1.5 system-ui, sans-serif; text-align: center; padding: 24px; box-sizing: border-box; }}
img {{ width: min(560px, 100%); height: auto; border-radius: 14px; }}
a {{ display: inline-block; margin-top: 18px; padding: 12px 22px; border-radius: 999px; background: linear-gradient(90deg, #ff3d9a, #a86bff); color: #fff; font-weight: 700; text-decoration: none; }}
</style>
</head>
<body>
<main>
<img src="img/{esc(fid)}.jpg?v={esc(img_ver)}" alt="{esc(name)}, {esc(meta)}">
<p><a id="go" href="{esc(card)}#festivals">Open {esc(name)} on Festival Radar</a></p>
</main>
<script>
(function () {{
  var u = '{card}', i = null;
  try {{ i = new URLSearchParams(location.search).get('i'); }} catch (e) {{}}
  if (i && /^[a-f0-9]{{8,32}}$/i.test(i)) u += '&invite=' + i.toLowerCase();
  u += '#festivals';
  document.getElementById('go').href = u;
  location.replace(u);
}})();
</script>
</body>
</html>
"""


def write_if_changed(path, data):
    mode = "wb" if isinstance(data, bytes) else "w"
    old = None
    if os.path.exists(path):
        with open(path, "rb" if mode == "wb" else "r", encoding=None if mode == "wb" else "utf-8") as fh:
            old = fh.read()
    if old == data:
        return False
    with open(path, mode, encoding=None if mode == "wb" else "utf-8") as fh:
        fh.write(data)
    return True


def main():
    with open(os.path.join(ROOT, "festivals.json"), encoding="utf-8") as fh:
        fests = json.load(fh).get("festivals", [])
    os.makedirs(IMG, exist_ok=True)
    changed = skipped = 0
    for f in fests:
        fid = str(f.get("id", ""))
        if not SAFE_ID.match(fid) or not f.get("festival"):
            skipped += 1
            continue
        jpg = make_image(f)
        ver = hashlib.sha1(jpg).hexdigest()[:8]
        changed += write_if_changed(os.path.join(IMG, fid + ".jpg"), jpg)
        changed += write_if_changed(os.path.join(OUT, fid + ".html"), make_page(f, ver))
    print(f"share pages: {len(fests) - skipped} festivals, {changed} files written, {skipped} skipped")


if __name__ == "__main__":
    sys.exit(main())
