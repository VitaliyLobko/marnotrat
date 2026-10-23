"""Іконки застосунку: золота монета з ₴ і крильцями («гроші полетіли») на зеленому — PNG для маніфесту й iOS.

MASK — масштаб для maskable: малюнок дрібніший, щоб лишався в безпечному колі Android (r = 40%).
Запуск: py scripts/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SS = 4  # малюємо вчетверо більшим і зменшуємо — згладжені краї
MASK = 0.8
ICONS = Path(__file__).resolve().parent.parent / 'icons'
FONT = 'C:/Windows/Fonts/segoeuib.ttf'


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def wing(d, cx, cy, s, side):
    """Крило з трьох пір'їн: еліпси, що розходяться віялом від монети."""
    for i, (dx, dy, w, hh) in enumerate([(70, -38, 120, 34), (62, 0, 104, 30), (50, 34, 82, 26)]):
        x = cx + side * dx * s
        y = cy + dy * s
        d.ellipse([x - w * s / 2, y - hh * s / 2, x + w * s / 2, y + hh * s / 2], fill=(255, 255, 255, 235 - i * 25))


def render(size, k):
    n = 512 * SS
    top, bottom = hex_rgb('#18d394'), hex_rgb('#0b8f63')
    bg = Image.new('RGB', (n, n))
    px = ImageDraw.Draw(bg)
    for y in range(n):
        t = y / (n - 1)
        px.line([(0, y), (n, y)], fill=tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(3)))

    over = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    s = SS * k
    c = 256 * SS
    cy = c + 10 * s
    wing(d, c - 70 * s, cy - 40 * s, s, -1)
    wing(d, c + 70 * s, cy - 40 * s, s, 1)
    # монета: тінь, обідок, поле
    r = 118 * s
    d.ellipse([c - r, cy - r + 10 * s, c + r, cy + r + 10 * s], fill=(0, 70, 45, 70))
    d.ellipse([c - r, cy - r, c + r, cy + r], fill=hex_rgb('#e9a400') + (255,))
    r2 = r - 16 * s
    d.ellipse([c - r2, cy - r2, c + r2, cy + r2], fill=hex_rgb('#ffcc00') + (255,))
    font = ImageFont.truetype(FONT, round(150 * s))
    d.text((c, cy + 4 * s), '₴', font=font, fill=hex_rgb('#c98500') + (255,), anchor='mm')

    img = Image.alpha_composite(bg.convert('RGBA'), over).convert('RGB')
    return img.resize((size, size), Image.LANCZOS)


def main():
    ICONS.mkdir(exist_ok=True)
    render(192, 1).save(ICONS / 'icon-192.png')
    render(512, 1).save(ICONS / 'icon-512.png')
    render(512, MASK).save(ICONS / 'icon-maskable-512.png')
    render(180, 1).save(ICONS / 'apple-touch-icon.png')


if __name__ == '__main__':
    main()
