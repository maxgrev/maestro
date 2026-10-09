#!/usr/bin/env python3
"""Create a reproducible SDK build tree; custom source stays outside the vendor code."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / ".cache/muse-gadget-sdk"
DEST = ROOT / "firmware/build/sdk"
if not (SOURCE / "esp32/components/muse/muse_chat_session.cpp").exists():
    raise SystemExit("Run scripts/bootstrap.sh to fetch the pinned Muse SDK first.")
def copy_changed(src, dst):
    source, destination = Path(src), Path(dst)
    if not destination.exists() or source.read_bytes() != destination.read_bytes():
        shutil.copy2(source, destination)
    return dst


shutil.copytree(SOURCE, DEST, dirs_exist_ok=True, copy_function=copy_changed, ignore=shutil.ignore_patterns(
    ".git", "source.tar.gz", "build*", "__pycache__", "managed_components"))
ESP = DEST / "esp32"
MUSE = ESP / "components/muse"
copy_changed(ROOT / "firmware/dependencies.lock", ESP / "dependencies.lock")

def edit(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"Upstream changed: expected exactly one edit anchor {old!r} in {path.name}")
    path.write_text(text.replace(old, new))

for path in (ROOT / "firmware/src").glob("*"):
    copy_changed(path, MUSE / path.name)
cfg = json.loads((ROOT / ".local/config.json").read_text())
device = json.loads((ROOT / ".local/device.json").read_text())
cert = (ROOT / ".local/bridge-cert.pem").read_text()
(MUSE / "maestro_config.h").write_text(
    "#pragma once\n"
    + "#define MAESTRO_URL " + json.dumps(device["url"]) + "\n"
    + "#define MAESTRO_TOKEN " + json.dumps(cfg["deviceToken"]) + "\n"
    + "#define MAESTRO_CA " + json.dumps(cert) + "\n"
)
edit(MUSE / "CMakeLists.txt", '"muse_app.c"', '"muse_app.c"\n        "maestro.c"')
edit(MUSE / "muse_app.c", '#include "muse_audio.h"', '#include "maestro.h"\n#include "muse_audio.h"')
edit(MUSE / "muse_app.c", "    muse_state_init();", "    muse_state_init();\n    maestro_init();")
edit(MUSE / "muse_ui.c", '#include "muse_state.h"', '#include "muse_state.h"\n#include "maestro.h"')
edit(MUSE / "muse_ui.c", "    build_overlays();", "    build_overlays();\n    maestro_ui_build(s_face ? s_face : lv_screen_active());")
edit(MUSE / "muse_voice.c", '#include "muse_wifi.h"', '#include "muse_wifi.h"\n#include "maestro_route.h"')
# Offline notes have no provider identity upstream. Never silently replay them to another agent.
edit(MUSE / "muse_voice.c", "#define HOLD_NOTES 1", "#define HOLD_NOTES 0")
edit(MUSE / "muse_voice.c", "NOTE SENT - WAITING FOR MUSE", "SENT - WAITING FOR REPLY")
edit(MUSE / "muse_input.c", '#include "muse_console.h"', '#include "muse_console.h"\n#include "maestro.h"')
edit(MUSE / "muse_input.c", '    if (!strcmp(line, "status")) {',
     '    if (!strcmp(line, "maestro.agents")) { maestro_show_agents(); return true; }\n'
     '    if (!strcmp(line, "status")) {')

# Use the SDK's own MP3 decoder and caption pacing for native Muse replies.
session = MUSE / "muse_chat_session.cpp"
edit(session, '#include "muse_chat_priv.h"', '#include "muse_chat_priv.h"\n#include "maestro.h"')
edit(session, 'static const char *TAG = "muse_chat_session";',
     'static const char *TAG = "muse_chat_session";\nstatic esp_http_client_handle_t s_maestro_tts;')
edit(session, "static void turn_reset_streams(void)\n{",
     "static void turn_reset_streams(void)\n{\n"
     "    if (s_maestro_tts) { esp_http_client_cleanup(s_maestro_tts); s_maestro_tts = nullptr; }")
edit(session, "        m.pcm_start = s_turn.pcm_out;\n        m.pcm_frames = (uint32_t)(m.len * MIC_RATE / TEXT_CHARS_PER_S);",
     """        if (s_turn.texts) {
            s_maestro_tts = maestro_tts_open(s_turn.texts + i * TEXT_MAX, "mp3");
            if (s_maestro_tts) {
                m.tts = TTS_ACTIVE;
                s_turn.tts_msg = i;
                s_turn.silent = false;
                m.pcm_start = s_turn.pcm_out;
                m.pcm_frames = 0;
                s_turn.mp3_len = 0;
                s_turn.mp3_ended = false;
                s_turn.kbps = 0;
                s_turn.down_rate = 0;
                mp3dec_init(&s_turn.dec);
                show_reply_start(m);
                return;
            }
        }
        m.pcm_start = s_turn.pcm_out;
        m.pcm_frames = (uint32_t)(m.len * MIC_RATE / TEXT_CHARS_PER_S);""")
edit(session, "static void decode(void)\n{", """static void decode(void)
{
    if (s_maestro_tts && s_turn.mp3_len < MP3_BUF) {
        size_t room = MP3_BUF - s_turn.mp3_len;
        int n = esp_http_client_read(s_maestro_tts, reinterpret_cast<char *>(s_turn.mp3 + s_turn.mp3_len),
                                    room > 4096 ? 4096 : room);
        if (n > 0) s_turn.mp3_len += n;
        else {
            esp_http_client_cleanup(s_maestro_tts);
            s_maestro_tts = nullptr;
            s_turn.mp3_ended = true;
        }
    }""")
token_file = ROOT / ".local/muse-sdk-token"
token = token_file.read_text().strip() if token_file.exists() else ""
if token and (not token.startswith("mgst_") or any(c.isspace() for c in token)):
    raise SystemExit("Invalid Muse SDK token file.")
overlay = (ROOT / "firmware/sdkconfig.maestro").read_text()
token_setting = "CONFIG_GADGET_SDK_TOKEN=" + json.dumps(token)
overlay += "\n" + token_setting + "\n"
(ESP / "sdkconfig.maestro").write_text(overlay)
# IDF defaults only fill unset values. Update the cached value too, or adding a
# token after the first build silently leaves the firmware's empty token intact.
cached_config = ESP / "build-maestro/sdkconfig"
if cached_config.exists():
    settings = cached_config.read_text().splitlines()
    settings = [line for line in settings if not line.startswith("CONFIG_GADGET_SDK_TOKEN=")
                and line != "# CONFIG_GADGET_SDK_TOKEN is not set"]
    cached_config.write_text("\n".join(settings) + "\n" + token_setting + "\n")
    cached_config.chmod(0o600)
print("Prepared pinned Muse SDK with Maestro routing, selector, and native Muse speech.")
if not token:
    print("Muse SDK token is not set. Firmware can build; Muse pairing needs the token.")
