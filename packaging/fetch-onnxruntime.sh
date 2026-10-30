#!/usr/bin/env bash
# Fetches the ONNX Runtime library Halo loads on Linux into onnxruntime/libonnxruntime.so.
#
# It's Microsoft's own build, taken from their Python package because that build needs nothing newer
# than glibc 2.28, so Halo runs on every current distro (the static builds ort can link in need
# glibc 2.38). The version must match the API the `ort` crate expects (ort 2.0.0-rc.15: 1.31).
set -euo pipefail
VERSION=1.31.1
WHEEL="onnxruntime-${VERSION}-cp312-cp312-manylinux_2_28_x86_64.whl"
SHA256=1f3dea47f2f0e5117c2404cea7d21fd253ae7836a3bf167a501cdfbb2600d536

cd "$(dirname "$0")/.."
mkdir -p onnxruntime
if [ "$(cat onnxruntime/VERSION 2>/dev/null)" = "$VERSION" ] && [ -f onnxruntime/libonnxruntime.so ]; then
  exit 0
fi
python3 - "$VERSION" "$WHEEL" "$SHA256" <<'PY'
import hashlib, io, json, sys, urllib.request, zipfile
version, wheel, sha256 = sys.argv[1:]
release = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/onnxruntime/{version}/json"))
url = next(f["url"] for f in release["urls"] if f["filename"] == wheel)
data = urllib.request.urlopen(url).read()
if hashlib.sha256(data).hexdigest() != sha256:
    sys.exit(f"{wheel} doesn't match its checksum")
with zipfile.ZipFile(io.BytesIO(data)) as z:
    open("onnxruntime/libonnxruntime.so", "wb").write(z.read(f"onnxruntime/capi/libonnxruntime.so.{version}"))
open("onnxruntime/VERSION", "w").write(version)
print(f"ONNX Runtime {version} is in onnxruntime/libonnxruntime.so")
PY
