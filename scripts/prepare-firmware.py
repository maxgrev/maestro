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

for path in (ROOT / "firmware/src").rglob("*"):
    if path.is_file():
        dest = MUSE / path.relative_to(ROOT / "firmware/src")
        dest.parent.mkdir(parents=True, exist_ok=True)
        copy_changed(path, dest)
# One firmware image for every user. Credentials arrive over USB and stay in NVS.
edit(MUSE / "CMakeLists.txt", '"muse_app.c"', '"muse_app.c"\n        "maestro.c"\n        "maestro_settings.c"\n        "maestro_avatar.c"')
edit(MUSE / "muse_app.c", '#include "muse_audio.h"', '#include "maestro.h"\n#include "muse_audio.h"')
edit(MUSE / "muse_app.c", "    muse_state_init();", "    muse_state_init();\n    maestro_init();")
edit(MUSE / "muse_ui.c", '#include "muse_state.h"', '#include "muse_state.h"\n#include "maestro.h"')
edit(MUSE / "muse_ui.c", 'static void invalidate_muse(void)\n{', '''static void invalidate_muse(void)
{
    // The native 64-cell sampler misses changes in higher-resolution characters.
    // Reset its cache so returning to Muse also repaints the whole character.
    if (maestro_character()) {
        s_cells_valid = false;
        lv_obj_invalidate(s_canvas);
        return;
    }''')
edit(MUSE / "muse_ui.c", "    build_overlays();", "    build_overlays();\n    maestro_ui_build(s_face ? s_face : lv_screen_active());")
edit(MUSE / "muse_ui.c", "    } else {\n        muse_menu_build(lv_screen_active(), s_w, s_h);\n    }",
     "    }\n    muse_menu_build(lv_screen_active(), 310, 330);")
edit(MUSE / "muse_ui.c", 'muse_board->touch ? LV_SYMBOL_POWER : LV_SYMBOL_LIST', 'LV_SYMBOL_LIST')
edit(MUSE / "muse_ui.c", '        return MODE_NAMES[MUSE_MODE_IDLE];', '        return maestro_idle_label();')
# Reuse the settings behavior within the round display's safe area.
menu = MUSE / "muse_menu.c"
edit(menu, '    lv_obj_set_size(s_root, w, h);',
     '    lv_obj_set_size(s_root, w, h);\n    lv_obj_center(s_root);\n    lv_obj_set_style_radius(s_root, 24, 0);\n    lv_obj_set_style_border_width(s_root, 1, 0);\n    lv_obj_set_style_border_color(s_root, lv_color_hex(0x31483e), 0);')
edit(menu, 'const lv_font_t *fine = small ? &lv_font_unscii_8 : &lv_font_unscii_16;',
     'const lv_font_t *fine = &lv_font_montserrat_14;')
edit(menu, 'muse_board->keyboard ? "Enter " : "", action', 'muse_board->keyboard ? "Enter " : "Yellow: ", action')
edit(menu, 's_hint_down = label(s_root, font, COLOR_TEXT, "");', 's_hint_down = label(s_root, fine, COLOR_TEXT, "");')
edit(menu, 's_hint_select = label(s_root, font, COLOR_TEXT, "");', 's_hint_select = label(s_root, fine, COLOR_TEXT, "");')
edit(menu, 's_down_text = muse_board->keyboard ? "Esc Back" : LV_SYMBOL_DOWN " Down";', 's_down_text = muse_board->keyboard ? "Esc Back" : "Blue: next";')
edit(menu, 'align_on_bar(s_hint_down, aux->align == LV_ALIGN_RIGHT_MID ? LV_ALIGN_BOTTOM_LEFT : aux->align, pad);', 'align_on_bar(s_hint_down, LV_ALIGN_BOTTOM_LEFT, pad);')
edit(menu, 'align_on_bar(s_hint_select, talk->align, pad);', 'align_on_bar(s_hint_select, LV_ALIGN_BOTTOM_RIGHT, pad);')
edit(menu, 'const muse_button_hint_t *talk = &muse_board->talk_hint, *aux = &muse_board->aux_hint;', 'const muse_button_hint_t *aux = &muse_board->aux_hint;')
avatar = ESP / "avatar/muse_pixel.c"
edit(avatar, '#include "muse_pixel.h"', '#include "muse_pixel.h"\n#include "maestro_avatar.h"')
edit(avatar, 'void muse_pixel_render(const muse_pose_t *p)\n{',
     'void muse_pixel_render(const muse_pose_t *p)\n{\n    if (maestro_avatar_render(p)) return;')
edit(avatar, '    int n = x1 - x0 + 1;',
     '    if (maestro_avatar_scale(dst, stride_px, x0, x1, y0, y1, s_size)) return;\n    int n = x1 - x0 + 1;')
edit(ESP / "main/identity.c", '#include "identity.h"', '#include "identity.h"\n#include "maestro_settings.h"')
edit(ESP / "main/identity.c", '    return CONFIG_GADGET_SDK_TOKEN[0] ? CONFIG_GADGET_SDK_TOKEN : NULL;',
     '    return maestro_muse_token();')
edit(MUSE / "muse_voice.c", '#include "muse_wifi.h"', '#include "muse_wifi.h"\n#include "maestro_route.h"')
# Offline notes have no provider identity upstream. Never silently replay them to another agent.
edit(MUSE / "muse_voice.c", "#define HOLD_NOTES 1", "#define HOLD_NOTES 0")
edit(MUSE / "muse_voice.c", "NOTE SENT - WAITING FOR MUSE", "SENT - WAITING FOR REPLY")
edit(MUSE / "muse_input.c", '#include "muse_console.h"', '#include "muse_console.h"\n#include "maestro.h"')
edit(MUSE / "muse_input.c", '#define SERIAL_LINE 1024', '#define SERIAL_LINE 8192')
edit(MUSE / "muse_input.c", '    if (!strcmp(line, "status")) {',
     '    if (maestro_console(line, whole)) return true;\n'
     '    if (!strcmp(line, "status")) {')
edit(MUSE / "muse_input.c", 'static void aux_key(bool pressed, bool edge)\n{',
     'static void aux_key(bool pressed, bool edge)\n{\n    maestro_aux(pressed, edge); return;')
edit(MUSE / "muse_input.c", '        } else if (muse_menu_is_open()) {',
     '        } else if (maestro_confirm()) {\n            swallow = true;\n        } else if (muse_menu_is_open()) {')
board = MUSE / "boards/board_m5stack_stopwatch.c"
edit(board, 'static unsigned poll_buttons(void)\n{', '''static volatile bool s_buzz;
void maestro_haptic(void) { s_buzz = true; }
static unsigned poll_buttons(void)
{
    static TickType_t buzz_until;
    if (s_buzz) {
        s_buzz = false;
        ioe_set(IOE_MOTOR, true);
        buzz_until = xTaskGetTickCount() + pdMS_TO_TICKS(35);
    } else if (buzz_until && (int32_t)(xTaskGetTickCount() - buzz_until) >= 0) {
        ioe_set(IOE_MOTOR, false);
        buzz_until = 0;
    }''')

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
token = ""
overlay = (ROOT / "firmware/sdkconfig.maestro").read_text()
token_setting = "CONFIG_GADGET_SDK_TOKEN=" + json.dumps(token)
overlay += "\n" + token_setting + "\n"
(ESP / "sdkconfig.maestro").write_text(overlay)
# IDF defaults only fill unset values. Update the cached value too, or adding a
# token after the first build silently leaves the firmware's empty token intact.
cached_config = ESP / "build-maestro/sdkconfig"
if cached_config.exists():
    settings = cached_config.read_text().splitlines()
    overrides = [line for line in overlay.splitlines() if line.startswith("CONFIG_") and "=" in line]
    names = {line.split("=", 1)[0] for line in overrides}
    settings = [line for line in settings if line.split("=", 1)[0] not in names
                and not any(line == f"# {name} is not set" for name in names)]
    cached_config.write_text("\n".join(settings + overrides) + "\n")
    cached_config.chmod(0o600)
print("Prepared generic Maestro firmware. Set up bridge and Muse credentials over USB.")
