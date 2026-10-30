#!/usr/bin/env bash
# Checks that an ffmpeg build has everything Halo uses, before it's packed into a release.
#   packaging/check-ffmpeg.sh path/to/ffmpeg [whisper]
# With "whisper" it also needs the whisper filter, which the Windows build uses for captions
# (Linux and macOS run whisper.cpp inside Halo instead).
set -euo pipefail
ffmpeg="$1"
filters=(alphaextract alphamerge aresample blend drawbox extractplanes fps gblur lut3d lutyuv maskedmerge negate pad
         scale split subtitles tile unpremultiply vstack color format null)
encoders=(libx264 libx265 libvpx-vp9 prores_ks libopus aac pcm_s16le mjpeg)
[ "${2:-}" = whisper ] && filters+=(whisper)

"$ffmpeg" -hide_banner -version | head -1
have_filters=$("$ffmpeg" -hide_banner -filters 2>/dev/null)
have_encoders=$("$ffmpeg" -hide_banner -encoders 2>/dev/null)
missing=()
for f in "${filters[@]}"; do grep -qE "^ [.A-Z|]+ $f " <<<"$have_filters" || missing+=("filter $f"); done
for e in "${encoders[@]}"; do grep -qE "^ [.A-Z]+ $e " <<<"$have_encoders" || missing+=("encoder $e"); done
if [ ${#missing[@]} -gt 0 ]; then
  printf 'This ffmpeg is missing: %s\n' "${missing[@]}" >&2
  exit 1
fi
# A real run: a frame converted to Rec.709 YUV and encoded as an export does.
"$ffmpeg" -v error -f lavfi -i "testsrc2=s=320x240:d=0.2" -vf "scale=out_color_matrix=bt709:out_range=tv" \
  -c:v libx264 -pix_fmt yuv420p -f null -
echo "ffmpeg has everything Halo needs."
