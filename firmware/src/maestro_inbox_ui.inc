static bool s_inbox_view;
static target_t *s_inbox_rows;
static size_t s_inbox_count;
static char s_inbox_filter[200], s_inbox_note[64];

static void list_render(void);
static void inbox_open(const char *target, uint64_t before)
{
    float seconds;
    if (muse_state_mode(&seconds) == MUSE_MODE_LISTENING) return;
    close_reader(NULL);
    s_inbox_view = true; s_inbox_count = 0; s_visible_count = 0; s_focus = 0;
    strlcpy(s_inbox_filter, target, sizeof(s_inbox_filter));
    strlcpy(s_inbox_note, "Loading replies…", sizeof(s_inbox_note));
    inbox_job_t job = {.kind = INBOX_PAGE, .id = before, .ticket = atomic_fetch_add(&s_inbox_ticket, 1) + 1};
    strlcpy(job.target, target, sizeof(job.target));
    if (!inbox_queue(job)) strlcpy(s_inbox_note, "Busy. Try again shortly.", sizeof(s_inbox_note));
    muse_ui_show_face(); muse_ui_set_swipe_enabled(false);
    atomic_store(&s_picker_open, true);
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_HIDDEN); lv_obj_move_foreground(s_panel);
    list_render(); muse_state_poke();
}
static bool inbox_choose(const target_t *target)
{
    if (!strcmp(target->id, "inbox")) { inbox_open("", 0); return true; }
    if (!strncmp(target->id, "older:", 6)) { inbox_open(s_inbox_filter, strtoull(target->id + 6, NULL, 10)); return true; }
    if (!strncmp(target->id, "reply:", 6)) {
        inbox_queue((inbox_job_t){.kind = INBOX_DETAIL, .id = strtoull(target->id + 6, NULL, 10), .ticket = atomic_fetch_add(&s_inbox_ticket, 1) + 1});
        lv_label_set_text(s_list_note, "Opening reply…");
        return true;
    }
    if (!target->available && !strcmp(target->status, "Saved replies")) { inbox_open(target->id, 0); return true; }
    return false;
}
static void inbox_reader_back(void)
{
    // Restore the existing list and scroll position. No refetch or agent switch.
    if (!s_panel) return;
    atomic_store(&s_picker_open, true);
    muse_ui_set_swipe_enabled(false);
    lv_obj_remove_flag(s_panel, LV_OBJ_FLAG_HIDDEN); lv_obj_move_foreground(s_panel);
}
static void inbox_ui_tick(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    cJSON *json = s_inbox_result; s_inbox_result = NULL;
    inbox_job_t job = s_inbox_result_job;
    xSemaphoreGive(s_lock);
    if (json && job.ticket == atomic_load(&s_inbox_ticket)) {
        if (job.kind == INBOX_PAGE && s_inbox_view && atomic_load(&s_picker_open)) {
            s_inbox_count = 0;
            cJSON *item;
            cJSON_ArrayForEach(item, cJSON_GetObjectItem(json, "items")) {
                if (s_inbox_count >= INBOX_ROWS - 1) break;
                target_t *row = &s_inbox_rows[s_inbox_count++]; *row = (target_t){.available = true};
                snprintf(row->id, sizeof(row->id), "reply:%.0f", cJSON_GetNumberValue(cJSON_GetObjectItem(item, "id")));
                cJSON *target = cJSON_GetObjectItem(item, "target");
                text_copy(row->name, field(target, "name"), sizeof(row->name));
                text_copy(row->detail, field(item, "reply"), sizeof(row->detail));
                const char *who = field(target, "character");
                row->character = !strcmp(who, "muse") ? 0 : !strcmp(who, "grok") ? 1 : !strcmp(who, "codex") ? 2 : !strcmp(who, "claude") ? 3 : 4;
                strlcpy(row->status, cJSON_IsTrue(cJSON_GetObjectItem(item, "read")) ? "" : cJSON_IsTrue(cJSON_GetObjectItem(item, "attention")) ? "!" : "1", sizeof(row->status));
            }
            cJSON *next = cJSON_GetObjectItem(json, "next");
            if (cJSON_IsNumber(next)) {
                target_t *row = &s_inbox_rows[s_inbox_count++]; *row = (target_t){.name = "Older replies", .available = true, .character = -1};
                snprintf(row->id, sizeof(row->id), "older:%.0f", next->valuedouble);
            }
            strlcpy(s_inbox_note, s_inbox_count ? "" : "No replies yet", sizeof(s_inbox_note));
            s_visible_count = 0; list_render();
        } else if (job.kind == INBOX_DETAIL && atomic_load(&s_picker_open)) {
            text_copy(s_reader_copy, field(json, "reply"), CAPTION_BYTES);
            lv_label_set_text_static(s_reader_text, s_reader_copy);
            lv_label_set_text(s_reader_note, cJSON_IsTrue(cJSON_GetObjectItem(json, "truncated")) || strlen(field(json, "reply")) >= CAPTION_BYTES ? "Continues in Maestro on Mac" : "");
            lv_obj_scroll_to_y(s_reader_scroll, 0, LV_ANIM_OFF);
            s_reader_inbox = true; open_reader(NULL);
            inbox_ack(&job.id, 1, true);
            for (size_t i = 0; i < s_inbox_count; i++) {
                if (!strncmp(s_inbox_rows[i].id, "reply:", 6) && strtoull(s_inbox_rows[i].id + 6, NULL, 10) == job.id) {
                    s_inbox_rows[i].status[0] = 0;
                    if (i < s_visible_count) s_visible[i].status[0] = 0;
                }
            }
        } else if (job.kind == INBOX_RESTORE && job.gen == atomic_load(&s_gen)) {
            xSemaphoreTake(s_lock, portMAX_DELAY);
            if (!s_reply.length && !strcmp(job.target, s_selected.id)) {
                maestro_reply_update(&s_reply, 0, field(json, "reply"), true);
                s_reply.truncated |= cJSON_IsTrue(cJSON_GetObjectItem(json, "truncated"));
                s_caption_gen = job.gen; s_auto_read_gen = job.gen;
                s_home_reply_id = (uint64_t)cJSON_GetNumberValue(cJSON_GetObjectItem(json, "id"));
            }
            xSemaphoreGive(s_lock);
        }
    }
    cJSON_Delete(json);
    float seconds;
    muse_mode_t mode = muse_state_mode(&seconds);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_read_turn[0] && s_read_turn_gen != atomic_load(&s_gen)) s_read_turn[0] = 0;
    if (s_read_turn[0] && !atomic_load(&s_picker_open) && !s_reader_inbox
        && (mode == MUSE_MODE_SPEAKING || mode == MUSE_MODE_IDLE)) {
        cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "turn", s_read_turn);
        if (inbox_post(INBOX_READ_TURN, body)) s_read_turn[0] = 0;
    }
    lv_label_set_text_fmt(s_home_badge, s_unread > 99 ? "99+" : "%u", s_unread);
    lv_obj_set_flag(s_home_badge, LV_OBJ_FLAG_HIDDEN, !s_unread);
    for (size_t i = 0; i < s_visible_count; i++) {
        char text[16] = "";
        if (s_inbox_view) strlcpy(text, s_visible[i].status, sizeof(text));
        else {
            unsigned count = !strcmp(s_visible[i].id, "inbox") ? s_unread : 0; bool attention = false;
            for (size_t j = 0; j < s_counts_len; j++) if (!strcmp(s_visible[i].id, s_counts[j].target)) {
                count = s_counts[j].unread; attention = s_counts[j].attention;
            }
            if (count) snprintf(text, sizeof(text), "%s%u", attention ? "! " : "", count);
            else if (!strcmp(s_visible[i].id, s_selected.id)) strlcpy(text, LV_SYMBOL_OK, sizeof(text));
        }
        lv_label_set_text(s_row_badges[i], text);
    }
    // No wake-up, speech, popup, or selection change. A short burst shares one
    // vibration after the current voice exchange AND any reading have finished.
    uint64_t newest = s_alert_len ? s_alerts[s_alert_len - 1] : 0;
    bool quiet = (mode == MUSE_MODE_IDLE || mode == MUSE_MODE_ERROR) && !atomic_load(&s_reader_open)
        && !atomic_load(&s_picker_open) && !maestro_ui_settings_is_open();
    if (maestro_notice_due(&s_notice, esp_timer_get_time() / 1000, quiet, newest)
        && inbox_ack(s_alerts, s_alert_len, false)) {
        s_notice.alerted = newest; s_alert_len = 0; s_alert_groups++;
        maestro_alert_haptic();
    }
    xSemaphoreGive(s_lock);
}
