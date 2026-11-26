#!/usr/bin/env python3
"""Render the menu bar Octo (#718): monochrome macOS template images.

The geometry is The Octo's animated rig (`OctoRig` in
`src/components/icons/OctoMark.tsx`, viewBox 0 0 64 66): the dome head, four
front arms (ellipses rx 5.5, ry 5.2 on y = 47) and two negative-space eyes.
Below 20px the back-arm row is dropped and the eyes grow to r = 3.6, as
`OctoMark` does at that size. Each state is a still pose of the rig's own
motion (`octo-m-*` in `src/styles.css`), so nothing is added to the creature:

- idle     the rig at rest;
- working  the eyes at the end of their scan (`octo-m-scan`, +2.4u) and the
           first and third arms at the top of their paddle (`octo-m-float`,
           -1.6u);
- blocked  "needs you": frozen, the eyes at half-mast (the reduced-motion pose
           of `octo-mascot--blocked`: scaleY(0.45) translateY(0.6)).

Template images carry shape in alpha only: macOS draws them in the menu bar's
own ink, light or dark, so there is no colour (and no brass) in them. The mark
is 16pt wide in an 18pt square (tray-icon draws the image 18pt tall), with its
straight sides on whole pixels. `@2x` is the image the app loads.

Run from the repo root (needs Pillow): python3 scripts/tray-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "tray"
SUPERSAMPLE = 16
EYE_R = 3.6
ARM_X = (15.5, 26.5, 37.5, 48.5)
ARM_RX, ARM_RY, ARM_Y = 5.5, 5.2, 47.0
EYE_X, EYE_Y = (25.0, 39.0), 27.0

# (arm y offsets, eye x offset, eye y scale, eye y offset)
POSES = {
    "idle": ((0.0, 0.0, 0.0, 0.0), 0.0, 1.0, 0.0),
    "working": ((-1.6, 0.0, -1.6, 0.0), 2.4, 1.0, 0.0),
    # CSS applies translateY(0.6) first, then scaleY(0.45) about the eye's centre.
    "blocked": ((0.0, 0.0, 0.0, 0.0), 0.0, 0.45, 0.6 * 0.45),
}


def cubic(p0, p1, p2, p3, steps=96):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        pts.append(
            (
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            )
        )
    return pts


# M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47 L10 47 Z
BODY = (
    cubic((10, 30), (10, 17.8), (19.8, 8), (32, 8))
    + cubic((32, 8), (44.2, 8), (54, 17.8), (54, 30))[1:]
    + [(54, 47), (10, 47)]
)


def render(pose, scale_pt):
    """One state at `scale_pt` points per pixel (1 = @1x, 2 = @2x)."""
    size = 18 * scale_pt
    k = SUPERSAMPLE * scale_pt
    unit = 16 / 44  # the mark's 44u width is 16pt
    # x = 10 lands on 1pt, the dome's top (y = 8) on 1pt.
    def px(x, y):
        return ((1 + (x - 10) * unit) * k, (1 + (y - 8) * unit) * k)

    arms, eye_dx, eye_sy, eye_dy = POSES[pose]
    mask = Image.new("L", (size * SUPERSAMPLE, size * SUPERSAMPLE), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([px(x, y) for x, y in BODY], fill=255)
    for cx, dy in zip(ARM_X, arms):
        x0, y0 = px(cx - ARM_RX, ARM_Y + dy - ARM_RY)
        x1, y1 = px(cx + ARM_RX, ARM_Y + dy + ARM_RY)
        draw.ellipse((x0, y0, x1, y1), fill=255)
    ry = EYE_R * eye_sy
    for cx in EYE_X:
        x0, y0 = px(cx + eye_dx - EYE_R, EYE_Y + eye_dy - ry)
        x1, y1 = px(cx + eye_dx + EYE_R, EYE_Y + eye_dy + ry)
        draw.ellipse((x0, y0, x1, y1), fill=0)
    alpha = mask.reduce(SUPERSAMPLE)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    image.putalpha(alpha)
    return image


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for pose in POSES:
        for scale, suffix in ((1, ""), (2, "@2x")):
            path = OUT / f"{pose}Template{suffix}.png"
            render(pose, scale).save(path, optimize=True)
            print(path.relative_to(OUT.parent.parent.parent))


if __name__ == "__main__":
    main()
