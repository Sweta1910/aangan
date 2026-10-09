"""Regenerate the MomSakhi app icons (PWA / Add to Home Screen) from the logo.

The artwork is the same petal logo app.js draws with logoMark() (marigold/
terracotta petals over a soft marigold disc, teal smile), placed on the app's
cream background, so the home-screen icon matches what moms see in the app.

Rasterised with Playwright (headless Chromium) because it is already the
screenshot dependency of this repo; no Pillow needed. Run from the repo root:

    python scripts/make_icons.py

Outputs (all opaque PNGs -- iOS shows transparency as black):
    icons/icon-192.png            manifest "any"
    icons/icon-512.png            manifest "any"
    icons/icon-maskable-512.png   manifest "maskable": logo kept inside the
                                  central 80% safe zone, background full-bleed
    icons/apple-touch-icon.png    180x180, iOS home screen
"""

import os

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "icons")

CREAM = "#FFF7EE"
# Same paths as logoMark() in app.js (viewBox 0 0 64 64).
LOGO = (
    '<circle cx="32" cy="32" r="32" fill="#FCEFD3"/>'
    '<path d="M32 13c6.5 7.5 8.5 15.5 0 28-8.5-12.5-6.5-20.5 0-28z" fill="#B9572F"/>'
    '<path d="M13 25.5c9.5 0 16 5.5 19 15.5-10.5 1-17-4.5-19-15.5z" fill="#E8A33D"/>'
    '<path d="M51 25.5c-9.5 0-16 5.5-19 15.5 10.5 1 17-4.5 19-15.5z" fill="#E8A33D"/>'
    '<path d="M17 46c4.6 2.6 9.6 3.8 15 3.8S42.4 48.6 47 46" stroke="#1E4D4F" '
    'stroke-width="3.2" fill="none" stroke-linecap="round"/>'
)


def svg(size, logo_fraction):
    """Cream square with the logo centred at logo_fraction of the width."""
    s = size * logo_fraction
    off = (size - s) / 2
    scale = s / 64
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
        '<rect width="%d" height="%d" fill="%s"/>'
        '<g transform="translate(%.3f %.3f) scale(%.5f)">%s</g></svg>'
        % (size, size, size, size, size, size, CREAM, off, off, scale, LOGO)
    )


# name -> (pixel size, fraction of the canvas the logo disc fills)
ICONS = {
    "icon-192.png": (192, 0.84),
    "icon-512.png": (512, 0.84),
    # Maskable: launchers may crop to a circle of 80% diameter; keep the disc at 64%.
    "icon-maskable-512.png": (512, 0.64),
    "apple-touch-icon.png": (180, 0.80),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, (size, frac) in ICONS.items():
            page = browser.new_page(viewport={"width": size, "height": size})
            page.set_content(
                '<html><body style="margin:0;background:%s">%s</body></html>' % (CREAM, svg(size, frac)))
            page.screenshot(path=os.path.join(OUT, name), omit_background=False)
            page.close()
            print("wrote icons/" + name)
        browser.close()


if __name__ == "__main__":
    main()
