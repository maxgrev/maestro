#!/usr/bin/env bash
# Build local tools and generic firmware. Never flash hardware or alter shell profiles.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
mode="${1:-all}"
case "$mode" in
  all|--bridge-only|--firmware-only) ;;
  *) echo 'Usage: bash scripts/bootstrap.sh [--bridge-only | --firmware-only]' >&2; exit 2 ;;
esac
if [[ "$mode" != --firmware-only && "$(uname -s)-$(uname -m)" != Darwin-arm64 ]]; then
  echo 'The Maestro bridge and Mac app require an Apple Silicon Mac.' >&2; exit 1
fi
for tool in git curl clang python3.13; do
  command -v "$tool" >/dev/null || { echo "Install $tool first (see README)." >&2; exit 1; }
done
if [[ "$mode" != --firmware-only ]]; then
  for tool in node npm lame; do
    command -v "$tool" >/dev/null || { echo "Install $tool first (see README)." >&2; exit 1; }
  done
  node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Maestro needs Node 24 or later.");process.exit(1)}'
fi
mkdir -p .cache .tools
fetch() {
  local url="$1" path="$2" sha="$3"
  if [[ ! -f "$path" ]]; then
    curl --fail --location --retry 3 "$url" -o "$path.part"
    mv "$path.part" "$path"
  fi
  local actual
  actual="$(shasum -a 256 "$path" | cut -d ' ' -f 1)"
  [[ "$actual" == "$sha" ]] || { echo "Checksum mismatch: $path" >&2; exit 1; }
}
if [[ ! -x .tools/python/bin/python ]]; then python3.13 -m venv .tools/python; fi
.tools/python/bin/pip install 'cmake==4.4.4' 'ninja==1.13.2' 'esptool==5.5.0' 'pyserial==3.5'
export PATH="$ROOT/.tools/python/bin:$PATH"
mkdir -p .cache/muse-gadget-sdk
fetch https://codeload.github.com/facebookincubator/muse-gadget-sdk/tar.gz/d7e5d22bbd1cb8e6369310f72039247b76942e5a \
  .cache/muse-gadget-sdk/source.tar.gz 8fb020a9c22684d1bff74a41809a3353555ba9c4f40d95c5b3175f74a9aee816
if [[ ! -f .cache/muse-gadget-sdk/esp32/CMakeLists.txt ]]; then
  tar -xzf .cache/muse-gadget-sdk/source.tar.gz -C .cache/muse-gadget-sdk --strip-components=1
fi
if [[ "$mode" != --bridge-only ]]; then
  if [[ ! -d .cache/esp-idf/.git ]]; then
    git clone --depth 1 --branch v6.0.1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git .cache/esp-idf
  fi
  [[ "$(git -C .cache/esp-idf rev-parse HEAD)" == 8c19b156084a0753687347cca1f5355782893533 ]]
  export IDF_TOOLS_PATH="$ROOT/.tools/espressif"
  bash .cache/esp-idf/install.sh esp32s3
  bash scripts/build-firmware.sh
fi
if [[ "$mode" == --firmware-only ]]; then
  echo 'StopWatch firmware built. No device was changed.'
  exit 0
fi
fetch https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-macos-aarch64 .tools/herdr \
  5173a3e0ae42d5d1ab7ebfa5d5e6329f7c3d23f8e1a3677c7ce3231da2884157
chmod +x .tools/herdr
.tools/python/bin/pip install -r desktop/requirements-speech.txt
.tools/python/bin/python scripts/fetch-voices.py
if [[ ! -d .cache/whisper.cpp/.git ]]; then
  git clone --depth 1 --branch v1.8.3 https://github.com/ggml-org/whisper.cpp.git .cache/whisper.cpp
fi
[[ "$(git -C .cache/whisper.cpp rev-parse HEAD)" == 2eeeba56e9edd762b4b38467bab96c2517163158 ]]
cmake -S .cache/whisper.cpp -B .cache/whisper-build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ROOT/.tools/whisper" -DCMAKE_INSTALL_RPATH='@loader_path/../lib' \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
cmake --build .cache/whisper-build --config Release -j 4
cmake --install .cache/whisper-build
fetch https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin .tools/whisper/ggml-base.bin \
  60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
npm ci
npm run setup
echo 'Maestro is ready. Run npm start and open http://localhost:4210/setup.html.'
