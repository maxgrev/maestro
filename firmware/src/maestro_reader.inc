// UI task only. The label owns a snapshot, never the worker's mutable reply.
static lv_obj_t *s_reader, *s_reader_scroll, *s_reader_text, *s_reader_note;
static lv_obj_t *s_reader_page_buttons[2];
#include "maestro_markdown.h"
static char *s_reader_copy, *s_reader_markdown;
static void reader_set_text(void)
{
    bool formatted = maestro_markdown(s_reader_copy, s_reader_markdown, CAPTION_BYTES * 2);
    // Keep literal # and code intact. LVGL recolor escapes can corrupt wrapping.
    lv_label_set_recolor(s_reader_text, false);
    lv_label_set_text_static(s_reader_text, formatted ? s_reader_markdown : s_reader_copy);
}
static uint32_t s_reader_version, s_auto_read_gen = UINT32_MAX;
static uint32_t s_reader_generation;
static atomic_int s_reader_y, s_reader_remaining;
static void close_list(void);
static bool s_reader_inbox;
static void inbox_reader_back(void);

static void close_reader(lv_event_t *event)
{
    (void)event;
    lv_obj_add_flag(s_reader, LV_OBJ_FLAG_HIDDEN);
    atomic_store(&s_reader_open, false);
    muse_ui_set_swipe_enabled(true);
    if (s_reader_inbox) { s_reader_inbox = false; s_reader_version = UINT32_MAX; inbox_reader_back(); }
    muse_state_poke();
}
static void open_reader(lv_event_t *event)
{
    (void)event;
    float seconds;
    if (!s_reader_copy[0] || muse_state_mode(&seconds) == MUSE_MODE_LISTENING) return;
    close_list();
    muse_ui_show_face();
    atomic_store(&s_reader_open, true);
    s_auto_read_gen = atomic_load(&s_gen);
    if (!s_reader_inbox && s_home_reply_id) inbox_ack(&s_home_reply_id, 1, true);
    muse_ui_set_swipe_enabled(false);
    lv_obj_remove_flag(s_reader, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_reader);
    muse_state_poke();
}
static void reader_page(int direction)
{
    // Keep one line of context between pages. Native touch scrolling remains free.
    int pitch = lv_font_get_line_height(&maestro_font_20) + 5;
    int32_t y = lv_obj_get_scroll_y(s_reader_scroll);
    int lines = (lv_obj_get_height(s_reader_scroll) + 5) / pitch;
    int32_t target = (y / pitch + direction * (lines - 1)) * pitch;
    lv_obj_scroll_by_bounded(s_reader_scroll, 0, y - target, LV_ANIM_OFF);
    muse_state_poke();
}
static void reader_page_clicked(lv_event_t *event)
{
    reader_page((intptr_t)lv_event_get_user_data(event));
}
static void reader_touched(lv_event_t *event)
{
    (void)event;
    muse_state_poke();
}
static void reader_tick(void)
{
    if (s_reader_inbox) {
        int32_t y = lv_obj_get_scroll_y(s_reader_scroll), remaining = lv_obj_get_scroll_bottom(s_reader_scroll);
        atomic_store(&s_reader_y, y); atomic_store(&s_reader_remaining, remaining);
        lv_obj_set_state(s_reader_page_buttons[0], LV_STATE_DISABLED, y <= 0);
        lv_obj_set_state(s_reader_page_buttons[1], LV_STATE_DISABLED, remaining <= 0);
        return;
    }
    bool changed, truncated;
    uint32_t generation;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    changed = s_reader_version != s_reply.version;
    if (changed) {
        memcpy(s_reader_copy, s_reply.text, s_reply.length + 1);
        s_reader_version = s_reply.version;
    }
    truncated = s_reply.truncated;
    generation = s_caption_gen;
    xSemaphoreGive(s_lock);
    if (changed) {
        int32_t y = lv_obj_get_scroll_y(s_reader_scroll);
        reader_set_text();
        lv_obj_update_layout(s_reader_scroll);
        lv_obj_scroll_to_y(s_reader_scroll, s_reader_copy[0] && generation == s_reader_generation ? y : 0, LV_ANIM_OFF);
        s_reader_generation = generation;
        lv_label_set_text(s_reader_note, truncated ? "Continues in Maestro on Mac" : "");
    }
    float seconds;
    muse_mode_t mode = muse_state_mode(&seconds);
    bool has_reply = s_reader_copy[0] && mode != MUSE_MODE_LISTENING;
    // Keep the reply itself available to tap after playback clears its caption.
    // Never replace a connection error or a transcript from the next recording.
    if (has_reply && mode == MUSE_MODE_IDLE) {
        char caption[MUSE_CAPTION_MAX];
        uint32_t version = 0;
        muse_state_caption(caption, sizeof(caption), &version);
        if (!caption[0]) muse_state_set_caption("%s", s_reader_copy);
    }
    if (!has_reply && atomic_load(&s_reader_open)) close_reader(NULL);
    if (has_reply && !muse_settings_speaker_on() && generation == atomic_load(&s_gen)
        && s_auto_read_gen != generation && !atomic_load(&s_picker_open)
        && !maestro_ui_settings_is_open()) open_reader(NULL);
    int32_t y = lv_obj_get_scroll_y(s_reader_scroll), remaining = lv_obj_get_scroll_bottom(s_reader_scroll);
    atomic_store(&s_reader_y, y);
    atomic_store(&s_reader_remaining, remaining);
    lv_obj_set_state(s_reader_page_buttons[0], LV_STATE_DISABLED, y <= 0);
    lv_obj_set_state(s_reader_page_buttons[1], LV_STATE_DISABLED, remaining <= 0);
}
static void reader_build(void)
{
    s_reader_copy = heap_caps_calloc(CAPTION_BYTES, 1, MUSE_BIG_CAPS);
    s_reader_markdown = heap_caps_calloc(CAPTION_BYTES * 2, 1, MUSE_BIG_CAPS);
    configASSERT(s_reader_copy && s_reader_markdown);
    lv_obj_t *label;
    s_reader = lv_obj_create(lv_screen_active());
    lv_obj_remove_style_all(s_reader);
    lv_obj_set_size(s_reader, lv_pct(100), lv_pct(100));
    lv_obj_set_style_bg_color(s_reader, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_reader, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_reader, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(s_reader, reader_touched, LV_EVENT_PRESSED, NULL);
    for (int i = 0; i < 2; i++) {
        lv_obj_t *button = lv_button_create(s_reader);
        s_reader_page_buttons[i] = button;
        lv_obj_remove_style_all(button);
        lv_obj_set_size(button, 48, 48);
        lv_obj_align(button, LV_ALIGN_CENTER, i ? 128 : -128, -138);
        lv_obj_set_style_text_color(button, lv_color_hex(i ? 0x658cff : 0xe8cb65), 0);
        lv_obj_set_style_text_opa(button, LV_OPA_60, LV_STATE_PRESSED);
        lv_obj_set_style_text_opa(button, LV_OPA_30, LV_STATE_DISABLED);
        label = lv_label_create(button);
        lv_obj_set_style_text_font(label, &maestro_font_24, 0);
        lv_label_set_text(label, i ? LV_SYMBOL_DOWN : LV_SYMBOL_UP); lv_obj_center(label);
        lv_obj_add_event_cb(button, reader_page_clicked, LV_EVENT_CLICKED, (void *)(intptr_t)(i ? 1 : -1));
    }
    maestro_back_button(s_reader, close_reader);
    label = lv_label_create(s_reader);
    lv_obj_set_style_text_font(label, &maestro_font_24, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(0xa77dff), 0);
    lv_label_set_text(label, "REPLY"); lv_obj_align(label, LV_ALIGN_CENTER, 0, -138);
    s_reader_scroll = lv_obj_create(s_reader);
    lv_obj_remove_style_all(s_reader_scroll);
    // Ten whole lines, with straight margins that keep text clear of the curve.
    lv_obj_set_size(s_reader_scroll, 326, 10 * lv_font_get_line_height(&maestro_font_20) + 9 * 5);
    lv_obj_align(s_reader_scroll, LV_ALIGN_TOP_MID, 0, 124);
    lv_obj_set_style_pad_right(s_reader_scroll, 14, 0);
    lv_obj_set_style_pad_bottom(s_reader_scroll, 8, 0);
    lv_obj_set_style_bg_opa(s_reader_scroll, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_reader_scroll, lv_color_black(), 0);
    lv_obj_set_scroll_dir(s_reader_scroll, LV_DIR_VER);
    lv_obj_remove_flag(s_reader_scroll, LV_OBJ_FLAG_SCROLL_CHAIN | LV_OBJ_FLAG_SCROLL_ELASTIC);
    lv_obj_set_scrollbar_mode(s_reader_scroll, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s_reader_scroll, lv_color_hex(0xa77dff), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s_reader_scroll, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s_reader_scroll, 4, LV_PART_SCROLLBAR);
    lv_obj_add_event_cb(s_reader_scroll, reader_touched, LV_EVENT_SCROLL, NULL);
    s_reader_text = lv_label_create(s_reader_scroll);
    lv_obj_set_width(s_reader_text, 312);
    lv_obj_set_style_text_font(s_reader_text, &maestro_font_20, 0);
    lv_obj_set_style_text_line_space(s_reader_text, 5, 0);
    lv_obj_set_style_text_color(s_reader_text, lv_color_hex(0xeeeaf5), 0);
    lv_label_set_long_mode(s_reader_text, LV_LABEL_LONG_MODE_WRAP);
    reader_set_text();
    s_reader_note = lv_label_create(s_reader);
    lv_obj_set_style_text_font(s_reader_note, &maestro_font_16, 0);
    lv_obj_align(s_reader_note, LV_ALIGN_TOP_MID, 0, 410);
    lv_label_set_text(s_reader_note, "");
    lv_obj_add_flag(s_reader, LV_OBJ_FLAG_HIDDEN);
}
