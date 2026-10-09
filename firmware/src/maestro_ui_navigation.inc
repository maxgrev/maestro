/* Included by muse_ui.c: keep touch and button navigation on the same tiles.
 * These helpers run only on the LVGL task. */
static void maestro_agents_clicked(lv_event_t *event)
{
    (void)event;
    maestro_show_agents();
}
static void maestro_reply_clicked(lv_event_t *event)
{
    (void)event;
    maestro_show_reply();
}

bool maestro_ui_settings_is_open(void)
{
    return s_tv && (lv_tileview_get_tile_active(s_tv) == s_settings || lv_obj_get_scroll_x(s_tv) > 0);
}

void maestro_ui_open_settings(void)
{
    float seconds;
    if (!s_tv || muse_state_mode(&seconds) == MUSE_MODE_LISTENING) return;
    maestro_settings_visible(true);
    muse_state_poke();
    lv_tileview_set_tile(s_tv, s_settings, LV_ANIM_ON);
    maestro_settings_focus_reset();
}
