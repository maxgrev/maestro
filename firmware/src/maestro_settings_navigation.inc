/* Included by muse_settings_ui.c. The SDK owns the pages and settings;
 * this adapter gives their existing widgets two-button access. */
static lv_group_t *s_maestro_focus;

void maestro_settings_focus_reset(void)
{
    if (s_maestro_focus) lv_group_remove_all_objs(s_maestro_focus);
}

static void maestro_collect_controls(lv_obj_t *parent)
{
    for (uint32_t i = 0; i < lv_obj_get_child_count(parent); i++) {
        lv_obj_t *obj = lv_obj_get_child(parent, i);
        if (lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN) || lv_obj_has_flag(obj, LV_OBJ_FLAG_USER_1) ||
            lv_obj_has_state(obj, LV_STATE_DISABLED)) continue;
        if (lv_obj_check_type(obj, &lv_button_class) || lv_obj_check_type(obj, &lv_switch_class) ||
            lv_obj_check_type(obj, &lv_slider_class) || lv_obj_check_type(obj, &lv_checkbox_class)) {
            if (lv_obj_get_group(obj) == s_maestro_focus) continue;
            lv_obj_set_style_outline_color(obj, lv_color_hex(0xe8cb65), LV_STATE_FOCUSED);
            lv_obj_set_style_outline_width(obj, 2, LV_STATE_FOCUSED);
            lv_obj_set_style_outline_pad(obj, 2, LV_STATE_FOCUSED);
            lv_group_add_obj(s_maestro_focus, obj);
        } else {
            maestro_collect_controls(obj);
        }
    }
}

void maestro_settings_key(unsigned key)
{
    if (key == 3) { maestro_settings_focus_reset(); go_back(); return; }
    if (!s_current) return;
    if (!s_maestro_focus) s_maestro_focus = lv_group_create();
    bool fresh = lv_group_get_obj_count(s_maestro_focus) == 0;
    maestro_collect_controls(s_current); /* Include newly scanned Wi-Fi rows. */
    if (key == 1 && !fresh) lv_group_focus_next(s_maestro_focus);
    lv_obj_t *obj = lv_group_get_focused(s_maestro_focus);
    if (!obj) return;
    lv_obj_t *visible = lv_obj_check_type(obj, &lv_slider_class) || lv_obj_check_type(obj, &lv_switch_class)
        ? lv_obj_get_parent(obj) : obj;
    lv_obj_scroll_to_view_recursive(visible, LV_ANIM_OFF);
    if (key != 2) return;
    if (lv_obj_check_type(obj, &lv_slider_class)) {
        int32_t low = lv_slider_get_min_value(obj), high = lv_slider_get_max_value(obj);
        int32_t value = lv_slider_get_value(obj), step = LV_MAX(1, (high - low) / 10);
        lv_slider_set_value(obj, value >= high ? low : LV_MIN(high, value + step), LV_ANIM_OFF);
        lv_obj_send_event(obj, LV_EVENT_VALUE_CHANGED, NULL);
        lv_obj_send_event(obj, LV_EVENT_RELEASED, NULL);
    } else if (lv_obj_has_flag(obj, LV_OBJ_FLAG_CHECKABLE)) {
        lv_obj_set_state(obj, LV_STATE_CHECKED, !lv_obj_has_state(obj, LV_STATE_CHECKED));
        lv_obj_send_event(obj, LV_EVENT_VALUE_CHANGED, NULL);
    } else {
        lv_obj_send_event(obj, LV_EVENT_CLICKED, NULL);
    }
}
