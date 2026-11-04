#!/usr/bin/env python3
"""Check a relocated app with isolated data, its own runtimes, and real speech."""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix="maestro-app-smoke-") as directory:
        work = Path(directory)
        app = work / "Relocated Maestro.app"
        shutil.copytree(ROOT / "dist/Maestro.app", app, symlinks=True)
        resources = app / "Contents/Resources"
        macho = {bytes.fromhex(magic) for magic in ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]}
        for path in resources.rglob("*"):
            if path.is_symlink() or not path.is_file():
                continue
            with path.open("rb") as binary:
                if binary.read(4) not in macho:
                    continue
            links = subprocess.check_output(["otool", "-L", str(path)], text=True)
            for line in links.splitlines()[1:]:
                if not line.startswith("\t"):
                    continue  # Universal binaries repeat a file header for each architecture.
                dependency = line.strip().split(" (", 1)[0]
                assert not dependency.startswith("/") or dependency.startswith(("/usr/lib/", "/System/Library/")), \
                    f"Bundled code still depends on a build-machine library: {path.name}: {dependency}"
        node = resources / ".tools/node/bin/node"
        python = resources / ".tools/python/bin/python3"
        data = work / "data"
        env = {**os.environ, "MAESTRO_DATA": str(data), "PYTHONDONTWRITEBYTECODE": "1",
               "MAESTRO_PYTHON": str(python), "MAESTRO_FIRMWARE": str(resources / "firmware"),
               "PATH": f"{resources / '.tools/node/bin'}:/usr/bin:/bin:/usr/sbin:/sbin"}
        subprocess.run([str(python), "-c", "import serial, esptool, kokoro_onnx, soxr"], check=True, cwd=resources, env=env)
        subprocess.run([str(node), "bridge/src/setup.js"], check=True, cwd=resources, env=env, capture_output=True)
        config_file = data / "config.json"
        config = json.loads(config_file.read_text())
        sockets = [socket.socket() for _ in range(3)]
        try:
            for connection in sockets:
                connection.bind(("127.0.0.1", 0))
            ports = [connection.getsockname()[1] for connection in sockets]
        finally:
            for connection in sockets:
                connection.close()
        config.update(localPort=ports[0], port=ports[1], remotePort=ports[2], host="127.0.0.1", projects=[])
        config["speech"].update(python=str(python), helper=str(resources / "scripts/speech.py"),
                                kokoro=str(resources / ".tools/kokoro"), lame=str(resources / ".tools/lame"))
        config_file.write_text(json.dumps(config))
        origin = f"http://127.0.0.1:{ports[0]}"
        # Ignore shell proxy settings: this check is strictly local.
        http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with (work / "bridge.log").open("w") as log:
            bridge = subprocess.Popen([str(node), "bridge/src/main.js"], cwd=resources, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if bridge.poll() is not None:
                        raise RuntimeError("The relocated bridge exited before becoming ready.")
                    try:
                        with http.open(origin + "/api/health", timeout=1) as response:
                            assert json.load(response)["name"] == "Maestro"
                        break
                    except (OSError, urllib.error.URLError):
                        time.sleep(.1)
                else:
                    raise TimeoutError("The relocated bridge did not start.")
                with http.open(origin + "/api/setup", timeout=10) as response:
                    setup = json.load(response)
                    assert setup["firmware"] is True and isinstance(setup["ports"], list), "USB setup or bundled firmware is unavailable."
                try:
                    http.open(f"http://127.0.0.1:{ports[2]}/api/health", timeout=5)
                    raise AssertionError("The device listener accepted an unauthenticated request.")
                except urllib.error.HTTPError as error:
                    assert error.code == 401
                request = urllib.request.Request(origin + "/api/speech", method="POST",
                    data=json.dumps({"text": "Maestro is ready.", "format": "pcm"}).encode(),
                    headers={"Content-Type": "application/json"})
                with http.open(request, timeout=60) as response:
                    assert response.headers["Content-Type"].startswith("audio/pcm")
                    audio = response.read()
                    assert len(audio) > 3200 and any(audio), "Speech returned empty or silent audio."
                recording = work / "speech.wav"
                with wave.open(str(recording), "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(16000)
                    output.writeframes(audio)
                transcript = work / "transcript"
                subprocess.run([str(resources / ".tools/whisper/bin/whisper-cli"), "-m",
                    str(resources / ".tools/whisper/ggml-base.bin"), "-f", str(recording),
                    "-otxt", "-of", str(transcript), "-nt", "-l", "en"],
                    check=True, cwd=resources, env=env, capture_output=True, timeout=120)
                assert "ready" in transcript.with_suffix(".txt").read_text().lower(), "Bundled transcription did not recognize the test phrase."
                mp3_request = urllib.request.Request(origin + "/api/speech", method="POST",
                    data=json.dumps({"text": "Maestro is ready.", "format": "mp3"}).encode(),
                    headers={"Content-Type": "application/json"})
                with http.open(mp3_request, timeout=60) as response:
                    mp3 = response.read()
                    assert response.headers["Content-Type"].startswith("audio/mpeg")
                    assert len(mp3) > 128 and (mp3.startswith(b"ID3") or mp3[0] == 0xff), "The bundled encoder returned invalid MP3 audio."
                print(f"Relocated app: USB imports, bridge, authentication, {len(audio)} PCM bytes, Whisper transcription, and MP3 speech passed.")
            finally:
                bridge.terminate()
                try:
                    bridge.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    bridge.kill()
                    bridge.wait()


if __name__ == "__main__":
    main()
