// USB-only display benchmark. Uses the real list and display refresh path.
// No agent messages, state changes or synthetic production UI.
#if CONFIG_LV_USE_SNAPSHOT
static int64_t s_bench_until, s_bench_started, s_bench_render;
static uint32_t s_bench_frames, s_bench_total_us, s_bench_max_us;
static void scroll_benchmark_event(lv_event_t *event)
{
    if (!s_bench_until) return;
    if (lv_event_get_code(event) == LV_EVENT_RENDER_START) s_bench_render = esp_timer_get_time();
    if (lv_event_get_code(event) == LV_EVENT_RENDER_READY && s_bench_render) {
        unsigned elapsed = esp_timer_get_time() - s_bench_render;
        s_bench_total_us += elapsed;
        s_bench_max_us = LV_MAX(s_bench_max_us, elapsed);
        s_bench_frames++;
        s_bench_render = 0;
    }
}
static void scroll_benchmark_start(void)
{
    if (!atomic_load(&s_picker_open)) open_list(NULL);
    if (!atomic_load(&s_picker_open) || s_inbox_view) return;
    lv_obj_scroll_to_y(s_rows, 0, LV_ANIM_OFF);
    lv_obj_update_layout(s_rows);
    s_bench_frames = s_bench_total_us = s_bench_max_us = 0;
    s_bench_started = esp_timer_get_time();
    s_bench_until = s_bench_started + 2000000;
    lv_obj_set_style_anim_duration(s_rows, 2000, 0);
    lv_obj_scroll_to_y(s_rows, 700, LV_ANIM_ON);
}
static void scroll_benchmark_tick(void)
{
    if (!s_bench_until || esp_timer_get_time() < s_bench_until) return;
    printf("@maestro.benchmark {\"frames\":%lu,\"elapsedMs\":%lld,\"renderMeanUs\":%lu,\"renderMaxUs\":%lu}\n",
           (unsigned long)s_bench_frames, (esp_timer_get_time() - s_bench_started) / 1000,
           (unsigned long)(s_bench_frames ? s_bench_total_us / s_bench_frames : 0), (unsigned long)s_bench_max_us);
    fflush(stdout);
    s_bench_until = 0;
    lv_obj_set_style_anim_duration(s_rows, 0, 0);
}
#endif
