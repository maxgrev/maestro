#!/usr/bin/env python3
"""Stream offline Kokoro speech as 16 kHz PCM or MP3. Text arrives on stdin."""
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soxr
from kokoro_onnx import Kokoro


async def main():
    request = json.load(sys.stdin)
    model = Path(sys.argv[1])
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(model / "model.onnx"), options, providers=["CPUExecutionProvider"])
    engine = Kokoro.from_session(session, str(model / "voices.bin"))
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
    try:
        asyncio.run(main())
    except BrokenPipeError:
        sys.exit(1)
