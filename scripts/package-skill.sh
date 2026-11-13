#!/usr/bin/env bash
#
# Package the skill for a skill marketplace.
#
# Agensi's shape, from their own example:
#
#     my-skill/
#     ├── SKILL.md
#     ├── scripts/run.py
#     └── reference/notes.md
#
# So: ONE top-level folder containing SKILL.md and whatever it needs, and
# no repository around it. The marketplace hands the folder to an agent;
# a repo's .git and 150 TypeScript files are not what it wants.
#
# Only the files SKILL.md actually references ship. The CLI itself is an
# npm package, not a file in the zip.
#
set -u

cd "$(dirname "$0")/.."

OUT="${OUT:-dist/skill}"
NAME="browser-verified-skill"

rm -rf "$OUT"
mkdir -p "$OUT/$NAME"

# SKILL.md, and the files it links to.
cp SKILL.md "$OUT/$NAME/SKILL.md"
cp -r references "$OUT/$NAME/references"
cp -r skills "$OUT/$NAME/skills"

# The marketplace needs a zip. Zip the FOLDER, not its contents, so the
# archive has one top-level directory.
#
# Python's zipfile is used rather than the `zip` binary, because `zip` is
# not installed everywhere and this has to work on a clean machine.
rm -f "$OUT/$NAME.zip"
python3 - "$OUT" "$NAME" <<'PYTHON'
import os
import sys
import zipfile

out, name = sys.argv[1], sys.argv[2]
root = os.path.join(out, name)

with zipfile.ZipFile(os.path.join(out, name + '.zip'), 'w', zipfile.ZIP_DEFLATED) as zf:
    for directory, _subdirs, files in os.walk(root):
        for filename in sorted(files):
            full = os.path.join(directory, filename)
            zf.write(full, os.path.relpath(full, out))
PYTHON

echo "the skill package:"
(cd "$OUT" && find "$NAME" -type f | sed 's/^/  /')
echo
echo "the archive: $OUT/$NAME.zip ($(du -k "$OUT/$NAME.zip" | cut -f1) KiB)"
