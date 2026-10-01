"""生成扩展图标（纯标准库，无第三方依赖）。

画一个蓝色渐变圆角方块 + 白色八分音符，4 倍超采样后缩小以得到平滑边缘。
"""
import os
import struct
import zlib

SS = 4                      # 超采样倍数
BASE = 128                  # 基准尺寸
CANVAS = BASE * SS

TOP = (0x4E, 0xAB, 0xED)    # 与弹窗主色一致的浅蓝
BOTTOM = (0x2C, 0x74, 0xC4)  # 渐变深蓝
NOTE = (255, 255, 255)
RADIUS = 26 * SS


def in_rounded_rect(x, y, size, radius):
    if radius <= 0:
        return True
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= radius * radius


def in_ellipse(x, y, cx, cy, rx, ry):
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    return dx * dx + dy * dy <= 1.0


def in_polygon(x, y, points):
    inside = False
    count = len(points)
    for i in range(count):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % count]
        if (y1 > y) != (y2 > y):
            slope = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < slope:
                inside = not inside
    return inside


# 播放三角（按 128 坐标系定义，再乘 SS）
PLAY = [
    (45 * SS, 31 * SS),
    (101 * SS, 64 * SS),
    (45 * SS, 97 * SS),
]


def render(size):
    """渲染 size x size 的 RGBA 像素。"""
    out = bytearray(size * size * 4)
    scale = CANVAS / size
    for py in range(size):
        for px in range(size):
            r_sum = g_sum = b_sum = a_sum = 0
            # 在源图上做 scale x scale 的盒式平均
            start_y = int(py * scale)
            start_x = int(px * scale)
            step = max(1, int(scale))
            samples = 0
            for sy in range(start_y, min(start_y + step, CANVAS)):
                for sx in range(start_x, min(start_x + step, CANVAS)):
                    samples += 1
                    if not in_rounded_rect(sx, sy, CANVAS, RADIUS):
                        continue
                    ratio = (sx + sy) / (2.0 * CANVAS)
                    r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * ratio)
                    g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * ratio)
                    b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * ratio)
                    if in_polygon(sx, sy, PLAY):
                        r, g, b = NOTE
                    r_sum += r
                    g_sum += g
                    b_sum += b
                    a_sum += 255
            samples = samples or 1
            index = (py * size + px) * 4
            out[index] = r_sum // samples
            out[index + 1] = g_sum // samples
            out[index + 2] = b_sum // samples
            out[index + 3] = a_sum // samples
    return bytes(out)


def write_png(path, size, pixels):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        payload = tag + data
        return (struct.pack(">I", len(data)) + payload +
                struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target = os.path.join(root, "icons")
    os.makedirs(target, exist_ok=True)
    for size in (16, 32, 48, 128):
        pixels = render(size)
        path = os.path.join(target, "icon%d.png" % size)
        write_png(path, size, pixels)
        print("wrote", path)


if __name__ == "__main__":
    main()
