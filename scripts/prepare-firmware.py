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
edit(MUSE / "CMakeLists.txt", '"muse_app.c"', '"muse_app.c"\n        "maestro.c"\n        "maestro_settings.c"\n        "maestro_avatar.c"\n        "maestro_reply.c"\n        "maestro_font.c"\n        "maestro_markdown.c"\n        "vendor/md4c/md4c.c"')
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
edit(MUSE / "muse_ui.c", "    build_overlays();", "    build_overlays();\n    maestro_ui_build(s_face ? s_face : lv_screen_active());\n    muse_pixel_set_size(s_canvas_px);")
edit(MUSE / "muse_ui.c", 'muse_board->touch ? LV_SYMBOL_POWER : LV_SYMBOL_LIST', 'LV_SYMBOL_LIST')
edit(MUSE / "muse_ui.c", '        return MODE_NAMES[MUSE_MODE_IDLE];', '        return maestro_idle_label();')
# Use the native touch settings for both swipe and physical buttons.
ui = MUSE / "muse_ui.c"
edit(ui, '#include "maestro.h"', '#include "maestro.h"\n#include "maestro_font.h"')
# Maestro overlays are siblings of the SDK face. The SDK cannot know they
# cover it; avoid repainting a 320x320 animation behind scrolling content.
edit(ui, '    update_chrome(now);', '''    if (maestro_picker_is_open() || maestro_reader_is_open()) return;
    update_chrome(now);''')
mic = ui.read_text()
mic = mic[mic.index('/* A microphone from primitives:'):mic.index('/* Icons beside the physical buttons,')]
edit(ui, mic, '''static lv_obj_t *make_mic(lv_obj_t *parent, int size)
{
    (void)size;
    lv_obj_t *icon = make_label(parent, &maestro_font_24, COLOR_DIM);
    lv_label_set_text(icon, MAESTRO_SYMBOL_MIC);
    return icon;
}
static void set_mic_color(uint32_t color)
{
    lv_obj_set_style_text_color(s_mic_icon, lv_color_hex(color), 0);
}

''')
edit(ui, 'static lv_obj_t *s_speaker;', 'static lv_obj_t *s_speaker;\nstatic lv_obj_t *s_mute_icon;\nstatic void maestro_agents_clicked(lv_event_t *event);\nstatic void maestro_reply_clicked(lv_event_t *event);')
edit(ui, '    lv_obj_align(s_state_lbl, LV_ALIGN_TOP_MID, 0, s_small ? 22 : 40 + s_dy);',
     '    lv_obj_align(s_state_lbl, LV_ALIGN_CENTER, 0, -138);')
edit(ui, 's_small ? 32 : 60 + s_dy', 's_small ? 32 : 111 + s_dy')
edit(ui, '    s_reply_lbl = make_label(face, font, COLOR_CAPTION);', '''    s_reply_lbl = make_label(face, font, COLOR_CAPTION);
    lv_obj_add_flag(s_reply_lbl, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_ext_click_area(s_reply_lbl, 12);
    lv_obj_set_style_text_opa(s_reply_lbl, LV_OPA_60, LV_STATE_PRESSED);
    lv_obj_add_event_cb(s_reply_lbl, maestro_reply_clicked, LV_EVENT_CLICKED, NULL);''')
edit(ui, '    s_caption_lbl = make_label(face, font_pick(caption_font(), &lv_font_unscii_8), COLOR_CAPTION);', '''    s_caption_lbl = make_label(face, font_pick(caption_font(), &lv_font_unscii_8), COLOR_CAPTION);
    lv_obj_add_flag(s_caption_lbl, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_ext_click_area(s_caption_lbl, 12);
    lv_obj_set_style_text_opa(s_caption_lbl, LV_OPA_60, LV_STATE_PRESSED);
    lv_obj_add_event_cb(s_caption_lbl, maestro_reply_clicked, LV_EVENT_CLICKED, NULL);''')
edit(ui, 'lv_obj_set_flag(lbl, LV_OBJ_FLAG_HIDDEN, !caption[0]);',
     'lv_obj_set_flag(lbl, LV_OBJ_FLAG_HIDDEN, !caption[0] || (mode == MUSE_MODE_LISTENING && (!strncmp(caption, "LISTENING", 9) || !strncmp(caption, "RECORDING", 9))));')
# Reading uses Maestro's scrollable full reply; keep home geometry stable on mute.
edit(ui, 'int layout = muse_settings_speaker_on() ? ANSWER_HEARD : ANSWER_READ;', 'int layout = ANSWER_HEARD;')
edit(ui, '    set_mic_color(COLOR_DIM);', '    set_mic_color(0xe8cb65);')
edit(ui, 'set_mic_color(mode == MUSE_MODE_LISTENING ? accent : COLOR_DIM);',
     'set_mic_color(mode == MUSE_MODE_LISTENING ? accent : 0xe8cb65);')
edit(ui, '    lv_obj_align(s_aux_icon, a->align, a->x, a->y);', '''    lv_obj_align(s_aux_icon, a->align, a->x, a->y);
    lv_obj_set_style_text_color(s_aux_icon, lv_color_hex(0x658cff), 0);
    lv_obj_add_flag(s_aux_icon, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_ext_click_area(s_aux_icon, 12);
    lv_obj_add_event_cb(s_aux_icon, maestro_agents_clicked, LV_EVENT_CLICKED, NULL);''')
edit(ui, '        build_speaker(face, spk_x, spk_y);', '        /* Volume and mute live in Settings > Sound. */')
edit(ui, '    int spk_x = -s_w / 2 + 8 + spk_r, spk_y = -s_h / 2 + 8 + spk_r;',
     '    int spk_y = -s_h / 2 + 8 + spk_r;')
edit(ui, '        int d = ring_in - spk_r - 4;   /* just inside the ring, even when swollen */\n        spk_x = -(int)sqrtf((float)(d * d - spk_y * spk_y));\n', '')
edit(ui, 'static void build_speaker(', 'static void __attribute__((unused)) build_speaker(')
edit(ui, '    s_power_lbl = make_label(status, &lv_font_unscii_8, COLOR_DIM);', '''    s_power_lbl = make_label(status, &lv_font_unscii_8, COLOR_DIM);
    s_mute_icon = make_label(status, &lv_font_montserrat_14, COLOR_DIM);''')
edit(ui, '    bool speaker = muse_settings_speaker_on();', '''    bool speaker = muse_settings_speaker_on();
    lv_label_set_text(s_mute_icon, speaker ? "" : LV_SYMBOL_MUTE);''')
edit(ui, '        s_dots[i] = d;', '        s_dots[i] = d;\n        lv_obj_add_flag(d, LV_OBJ_FLAG_HIDDEN);')
edit(ui, '        bool swipe = !page || !subpage;', '        bool swipe = (!page || !subpage) && !maestro_picker_is_open() && !maestro_reader_is_open();')
edit(ui, 'lv_obj_set_flag(s_dots[i], LV_OBJ_FLAG_HIDDEN, page && subpage);', 'lv_obj_add_flag(s_dots[i], LV_OBJ_FLAG_HIDDEN);')
with ui.open("a") as out:
    out.write('\n#include "maestro_ui_navigation.inc"\n')
settings = MUSE / "muse_settings_ui.c"
edit(settings, '#include "muse_settings_ui.h"', '#include "muse_settings_ui.h"\n#include "maestro.h"\n#include "maestro_font.h"')
edit(settings, '#define LIST_W 330', '#define LIST_W 310')
edit(settings, '#define LIST_TOP 84', '#define LIST_TOP 120')
edit(settings, '    lv_obj_align(b, LV_ALIGN_TOP_MID, -112, 28);',
     '    lv_obj_align(b, LV_ALIGN_TOP_MID, -112, 28);\n    lv_obj_add_flag(b, LV_OBJ_FLAG_USER_1); /* Hold blue already goes back. */')
edit(settings, '        lv_obj_t *b = back_button(p);', '        lv_obj_t *b = maestro_back_button(p, on_back);')
edit(settings, 'compact ? (back ? 12 : 8) : 44', 'compact ? (back ? 12 : 8) : 87')
edit(settings, '    catch_swipes(p);', '    catch_swipes(p);\n    maestro_menu_icons(p);')
edit(settings, 'muse_board->height - list_top);', 'muse_board->height - list_top - (muse_board->round ? 70 : 0));')
edit(settings, '    s_sound = page(tile, "SOUND", true, &list);',
     '    s_sound = page(tile, "SOUND", true, &list);\n    if (muse_board->round) lv_obj_set_height(list, 244);')
edit(settings, 'compact ? 32 : 110', 'compact ? 32 : 16')
edit(settings, '    lv_obj_set_style_pad_row(list, 10, 0);',
     '    lv_obj_set_style_pad_row(list, 10, 0);\n    lv_obj_set_style_pad_top(list, 4, 0);\n    lv_obj_set_style_pad_hor(list, 4, 0);')
edit(settings, '    s_current = p;', '    s_current = p;\n    maestro_settings_focus_reset();')
edit(settings, '        show(s_home);\n    }\n}', '        show(s_home);\n    } else {\n        muse_ui_show_face();\n    }\n}')
edit(settings, '    s_home = page(tile, "SETTINGS", false, &list);',
     '    s_home = page(tile, "SETTINGS", true, &list);\n    row(list, LV_SYMBOL_VOLUME_MAX, "Sound", &s_home_sound, on_nav, (void *)&SOUND);')
edit(settings, '    row(list, LV_SYMBOL_BLUETOOTH, "Bluetooth", &s_home_ble, on_nav, (void *)&BLE);\n    row(list, LV_SYMBOL_VOLUME_MAX, "Sound", &s_home_sound, on_nav, (void *)&SOUND);',
     '    row(list, LV_SYMBOL_BLUETOOTH, "Bluetooth", &s_home_ble, on_nav, (void *)&BLE);')
with settings.open("a") as out:
    out.write('\n#include "maestro_settings_navigation.inc"\n')
# One bitmap family for native settings, keyboard, pairing, captions and icons.
# Keep the tiny battery caption and CJK fallback supplied by the SDK.
for screen in (ui, settings):
    text = screen.read_text()
    for old, new in (("lv_font_montserrat_12", "maestro_font_16"),
                     ("lv_font_montserrat_14", "maestro_font_16"),
                     ("lv_font_montserrat_16", "maestro_font_16"),
                     ("lv_font_montserrat_20", "maestro_font_20"),
                     ("lv_font_montserrat_28", "maestro_font_24"),
                     ("lv_font_unscii_16", "maestro_font_20")):
        text = text.replace(old, new)
    screen.write_text(text)
edit(settings, 'lv_obj_set_style_radius(c, 18, 0);', 'lv_obj_set_style_radius(c, 0, 0);')
for widget, old in (("s_text_show",14),("s_text_ta",14)):
    edit(settings, f'lv_obj_set_style_radius({widget}, {old}, 0);', f'lv_obj_set_style_radius({widget}, 0, 0);')
edit(settings, 'lv_obj_set_style_radius(s_text_kb, 8, LV_PART_ITEMS);', 'lv_obj_set_style_radius(s_text_kb, 0, LV_PART_ITEMS);')
edit(settings, '    lv_obj_set_size(sw, 60, 32);', '''    lv_obj_set_size(sw, 60, 32);
    lv_obj_set_style_radius(sw, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(sw, 0, LV_PART_INDICATOR);
    lv_obj_set_style_radius(sw, 0, LV_PART_KNOB);''')
edit(settings, '    lv_slider_set_range(s, lo, hi);', '''    lv_obj_set_style_radius(s, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s, 0, LV_PART_INDICATOR);
    lv_obj_set_style_radius(s, 0, LV_PART_KNOB);
    lv_slider_set_range(s, lo, hi);''')
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
edit(board, '{ LV_ALIGN_CENTER, -91, -178 }', '{ LV_ALIGN_CENTER, -128, -138 }')
edit(board, '{ LV_ALIGN_CENTER, 91, -178 }', '{ LV_ALIGN_CENTER, 128, -138 }')
edit(board, 'static unsigned poll_buttons(void)\n{', '''static volatile unsigned s_buzz;
void maestro_haptic(void) { s_buzz = 35; }
void maestro_alert_haptic(void) { s_buzz = 160; }
static unsigned poll_buttons(void)
{
    static TickType_t buzz_until;
    if (s_buzz) {
        unsigned duration = s_buzz; s_buzz = 0;
        ioe_set(IOE_MOTOR, true);
        buzz_until = xTaskGetTickCount() + pdMS_TO_TICKS(duration);
    } else if (buzz_until && (int32_t)(xTaskGetTickCount() - buzz_until) >= 0) {
        ioe_set(IOE_MOTOR, false);
        buzz_until = 0;
    }''')

# Screen and codecs may sleep; an enabled inbox still needs its network.
edit(MUSE / "muse_input.c", 'bool nap = paused && !muse_voice_notes_waiting()',
     'bool nap = paused && !maestro_inbox_enabled() && !muse_voice_notes_waiting()')
# Use the SDK's own MP3 decoder and caption pacing for native Muse replies.
session = MUSE / "muse_chat_session.cpp"
edit(session, '#include "muse_chat_priv.h"', '#include "muse_chat_priv.h"\n#include "maestro.h"')
edit(session, 'static const char *TAG = "muse_chat_session";',
     'static const char *TAG = "muse_chat_session";\nstatic esp_http_client_handle_t s_maestro_tts;\nstatic uint32_t s_maestro_reply_gen;')
# Forward complete events from the existing subscription, including when another
# agent is selected. Never feed them into the active voice turn.
edit(session, '    if (s_turn.phase != P_WAIT_REPLY) {\n        return;\n    }\n    const char *event', '''    const char *inbox_event = cJSON_GetStringValue(cJSON_GetObjectItem(line, "event")) ?: "";
    cJSON *inbox_payload = cJSON_GetObjectItem(line, "payload");
    if (!strcmp(inbox_event, "delta.message_done") ||
        (!strcmp(inbox_event, "message.assistant") && !cJSON_IsFalse(cJSON_GetObjectItem(inbox_payload, "display_text_ready")))) {
        const char *text = cJSON_GetStringValue(cJSON_GetObjectItem(inbox_payload, "display_text"));
        if (!text) text = cJSON_GetStringValue(cJSON_GetObjectItem(inbox_payload, "content"));
        bool foreground = s_turn.phase == P_WAIT_REPLY && !s_turn.text && s_turn.gen == s_gen.load()
            && s_maestro_reply_gen == maestro_reply_generation() && maestro_character() == 0;
        maestro_muse_inbox(msg_id(inbox_payload, line), text, foreground);
    }
    if (s_turn.phase != P_WAIT_REPLY) {
        return;
    }
    const char *event''')
edit(session, 's_turn.phase == P_IDLE && t - s_conn.last_use_us > IDLE_CLOSE_US',
     's_turn.phase == P_IDLE && !maestro_inbox_enabled() && t - s_conn.last_use_us > IDLE_CLOSE_US')
edit(session, 's_resting ? -1 : 200', '(s_resting && !maestro_inbox_enabled()) ? -1 : 200')
edit(session, '    s_turn.gen = gen;', '    s_turn.gen = gen;\n    s_maestro_reply_gen = maestro_reply_generation();')
edit(session, '    m.done = true;', '''    m.done = true;
    if (!s_turn.text && s_turn.gen == s_gen.load())
        maestro_muse_reply(s_maestro_reply_gen, i, final_text ? final_text : "", true);''')
edit(session, '        const char *text = cJSON_GetStringValue(cJSON_GetObjectItem(payload, "text"));', '''        const char *text = cJSON_GetStringValue(cJSON_GetObjectItem(payload, "text"));
        if (text && text[0] && !s_turn.text && s_turn.gen == s_gen.load())
            maestro_muse_reply(s_maestro_reply_gen, i, text, false);''')
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
