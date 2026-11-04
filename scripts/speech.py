#!/usr/bin/env python3
"""Stream offline Kokoro speech as 16 kHz PCM or MP3. Text arrives on stdin."""
import asyncio
import json
import subprocess
import sys
import struct
import signal
import tempfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soxr
import espeakng_loader
from kokoro_onnx import Kokoro, EspeakConfig


async def main(espeak_data):
    model = Path(sys.argv[1])
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(model / "model.onnx"), options, providers=["CPUExecutionProvider"])
    engine = Kokoro.from_session(session, str(model / "voices.bin"), EspeakConfig(data_path=str(espeak_data)))
    if sys.argv[2] == "--persistent":
        # One JSON line per reply; bounded PCM frames and a zero-length terminator.
        # stdout contains only framed audio. A crash/closed pipe invalidates a turn.
        for line in sys.stdin:
            request = json.loads(line)
            voice = request["voice"]
            async for samples, rate in engine.create_stream(request["text"], voice=voice, lang="en-gb" if voice.startswith("b") else "en-us"):
                pcm = (np.clip(soxr.resample(samples, rate, 16000), -1, 1) * 32767).astype("<i2").tobytes()
                for offset in range(0, len(pcm), 32768):
                    frame = pcm[offset:offset + 32768]
                    sys.stdout.buffer.write(struct.pack("<I", len(frame)) + frame)
                    sys.stdout.buffer.flush()
            sys.stdout.buffer.write(struct.pack("<I", 0))
            sys.stdout.buffer.flush()
        return
    request = json.load(sys.stdin)
    encoder = None
    output = sys.stdout.buffer
    if request["format"] == "mp3":
        encoder = subprocess.Popen([sys.argv[2], "--quiet", "-r", "-s", "16", "--bitwidth", "16",
                                    "--signed", "--little-endian", "-m", "m", "-b", "48", "-", "-"],
                                   stdin=subprocess.PIPE, stdout=output)
        output = encoder.stdin
    try:
        voice = request["voice"]
        async for samples, rate in engine.create_stream(request["text"], voice=voice, lang="en-gb" if voice.startswith("b") else "en-us"):
            samples = soxr.resample(samples, rate, 16000)
            output.write((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            output.flush()
        if encoder:
            output.close()
            if encoder.wait(timeout=10):
                raise RuntimeError("Speech encoder failed")
    finally:
        if encoder and encoder.poll() is None:
            encoder.terminate()
            encoder.wait(timeout=10)


if __name__ == "__main__":
    # eSpeak 1.52 has a 160-byte data-path buffer. App Translocation and long
    # install paths can exceed it, silently selecting the build machine's path.
    # Pass a short *parent* directory: Phonemizer resolves the parent, while
    # eSpeak follows its espeak-ng-data link without expanding the stored path.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with tempfile.TemporaryDirectory(prefix="maestro-espeak-", dir="/tmp") as directory:
        (Path(directory) / "espeak-ng-data").symlink_to(espeakng_loader.get_data_path(), target_is_directory=True)
        try:
            asyncio.run(main(Path(directory)))
        except BrokenPipeError:
            sys.exit(1)
