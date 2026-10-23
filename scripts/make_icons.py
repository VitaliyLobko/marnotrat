"""Іконки застосунку: велика золота монета з карбованим ₴ (Times, вдавлений) на зеленому — PNG для маніфесту й iOS.

MASK — масштаб для maskable: малюнок дрібніший, щоб лишався в безпечному колі Android (r = 40%).
Запуск: py scripts/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SS = 4  # малюємо вчетверо більшим і зменшуємо — згладжені краї
MASK = 0.8
ICONS = Path(__file__).resolve().parent.parent / 'icons'
FONT = 'C:/Windows/Fonts/timesbd.ttf'


def rgb(h, a=255):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (a,)


def render(size, k):
    n = 512 * SS
    top, bottom = rgb('#18d394'), rgb('#0b8f63')
    img = Image.new('RGBA', (n, n))
    px = ImageDraw.Draw(img)
    for y in range(n):
        t = y / (n - 1)
        px.line([(0, y), (n, y)], fill=tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(4)))

    d = ImageDraw.Draw(img)
    s = SS * k
    c = n // 2
    # монета: тінь, обідок, поле, блік
    r = 178 * s
    d.ellipse([c - r, c - r + 16 * s, c + r, c + r + 16 * s], fill=(0, 60, 40, 80))
    d.ellipse([c - r, c - r, c + r, c + r], fill=rgb('#e9a400'))
    r2 = r * .86
    d.ellipse([c - r2, c - r2, c + r2, c + r2], fill=rgb('#ffcc00'))
    d.chord([c - r2 * .8, c - r2 * .85, c + r2 * .2, c + r2 * .1], 200, 300, fill=(255, 255, 255, 90))
    # тонкий внутрішній обідок, як на справжній монеті: тінь і світлий відблиск під нею
    r3 = r * .74
    d.ellipse([c - r3, c - r3, c + r3, c + r3], outline=rgb('#e0a000'), width=round(5 * s))
    d.ellipse([c - r3 + 4 * s, c - r3 + 4 * s, c + r3 + 4 * s, c + r3 + 4 * s], outline=rgb('#fff0a0', 160), width=round(3 * s))
    # ₴ вдавлений у метал: світлий край унизу-праворуч, тіло — тінь; по центру за габаритом знака
    font = ImageFont.truetype(FONT, round(238 * s))
    mask = Image.new('L', (n, n), 0)
    md = ImageDraw.Draw(mask)
    x0, y0, x1, y1 = md.textbbox((0, 0), '₴', font=font)
    md.text((c - (x0 + x1) / 2, c - (y0 + y1) / 2), '₴', font=font, fill=255)
    off = round(7 * s * 2 / 3)
    img.paste(rgb('#fff6c8'), (off, off), mask)
    img.paste(rgb('#9a6100'), (0, 0), mask)

    return img.convert('RGB').resize((size, size), Image.LANCZOS)


def main():
    ICONS.mkdir(exist_ok=True)
    render(192, 1).save(ICONS / 'icon-192.png')
    render(512, 1).save(ICONS / 'icon-512.png')
    render(512, MASK).save(ICONS / 'icon-maskable-512.png')
    render(180, 1).save(ICONS / 'apple-touch-icon.png')


if __name__ == '__main__':
    main()
