#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Build a byte-reproducible zip from a directory.

Every entry is written with a fixed timestamp, a canonical order, and no
extra fields, so the same directory contents always produce the same bytes.
File modes are normalized (0644) — the extension package contains no
executables. Used by the release workflow; the double-build check in CI
proves the equality this script promises.

    scripts/reprozip.py --root dist/chrome --out store/pkg/leia-chrome.zip --epoch 1760000000
"""

import argparse
import os
import time
import zipfile


def clamp_epoch(epoch: int) -> int:
    # Zip timestamps start at 1980-01-01; earlier epochs are clamped.
    return max(epoch, 315532800)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        required=True,
        help="directory to zip (contents go to the archive root)",
    )
    parser.add_argument("--out", required=True, help="zip file to write")
    parser.add_argument(
        "--epoch",
        type=int,
        default=None,
        help="fixed mtime (seconds); defaults to SOURCE_DATE_EPOCH or now",
    )
    args = parser.parse_args()

    epoch = clamp_epoch(
        args.epoch
        if args.epoch is not None
        else int(os.environ.get("SOURCE_DATE_EPOCH", time.time()))
    )
    stamp = time.gmtime(epoch)[:6]
    root = os.path.abspath(args.root)

    entries: list[str] = []
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            entries.append((full, os.path.relpath(full, root)))
    entries.sort(key=lambda pair: pair[1])

    with open(args.out, "wb") as out:
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for full, rel in entries:
                info = zipfile.ZipInfo(rel, date_time=stamp)
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as f:
                    z.writestr(info, f.read())

    print(f"{args.out}: {len(entries)} files, epoch {epoch}")


if __name__ == "__main__":
    main()
