"""Detect the square outline in a screenshot of a Cloudflare Turnstile widget."""

import io
import sys
from PIL import Image


def visible_checkbox(data):
    image = Image.open(io.BytesIO(data)).convert('L')
    width, height = image.size
    if width < 200 or height < 40:
        return False
    pixels = image.load()
    # The checkbox occupies the left side of the 300x65 Turnstile widget.
    # Require all four straight edges; the loading spinner cannot satisfy this.
    for size in range(18, 33):
        for x in range(6, min(40, width - size)):
            for y in range(8, min(height - size, 42)):
                def edge(points):
                    return sum(pixels[px, py] < 145 for px, py in points) >= size * 0.7
                top = edge((x + i, y) for i in range(size))
                bottom = edge((x + i, y + size - 1) for i in range(size))
                left = edge((x, y + i) for i in range(size))
                right = edge((x + size - 1, y + i) for i in range(size))
                if top and bottom and left and right:
                    return True
    return False


if __name__ == '__main__':
    print('1' if visible_checkbox(sys.stdin.buffer.read()) else '0')
