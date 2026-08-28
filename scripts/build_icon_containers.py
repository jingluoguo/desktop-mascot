"""Pack the generated PNG logo into macOS ICNS and Windows ICO containers."""

from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"


def png(name: str) -> bytes:
    return (ICONS / name).read_bytes()


def write_icns() -> None:
    entries = [
        (b"ic10", "32x32.png"),
        (b"ic11", "128x128.png"),
        (b"ic07", "128x128@2x.png"),
        (b"ic08", "256x256.png"),
        (b"ic09", "512x512.png"),
        (b"ic14", "icon.png"),
    ]
    chunks = [tag + struct.pack(">I", len(data) + 8) + data for tag, name in entries for data in [png(name)]]
    payload = b"".join(chunks)
    (ICONS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)


def write_ico() -> None:
    names = ["32x32.png", "128x128.png", "128x128@2x.png", "512x512.png"]
    images = [png(name) for name in names]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    directory = []
    for name, image in zip(names, images):
        size = 32 if name == "32x32.png" else 128 if name == "128x128.png" else 0
        directory.append(struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(image), offset))
        offset += len(image)
    (ICONS / "icon.ico").write_bytes(header + b"".join(directory) + b"".join(images))


if __name__ == "__main__":
    write_icns()
    write_ico()
