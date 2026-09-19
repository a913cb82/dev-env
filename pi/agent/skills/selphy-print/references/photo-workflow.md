# Photo Workflow

Phone photos use 4:3 shape. Postcard paper uses 3:2 shape. Borderless prints need a 3:2 file.

## Keep Full Image

- Run `lp -o fit-to-page FILE` with the bash tool.
- The command keeps the full image.
- The print has thin white bands on two sides.

## Borderless Print

1. Confirm the image path with the read tool.
2. Run the Python crop command with the bash tool.
3. Run `lp FILE-3x2.jpg` with the bash tool to print.

The crop centers on the image. The crop keeps full width for landscape photos. The crop trims top and bottom equally. The crop keeps full height for portrait photos. The crop trims left and right equally.

## Crop Command

The command needs Pillow. Run it with the bash tool. Replace `photo.jpg` and `photo-3x2.jpg` with real paths.

```bash
python3 - "photo.jpg" "photo-3x2.jpg" <<'PY'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w, h = im.size
th = round(w / 3 * 2)
if th > h:
    tw = round(h / 3 * 2)
    left = (w - tw) // 2
    im.crop((left, 0, left + tw, h)).save(dst, "JPEG", quality=95)
else:
    top = (h - th) // 2
    im.crop((0, top, w, top + th)).save(dst, "JPEG", quality=95)
print(dst)
PY
```
