# StopWatch pixel UI

Agent and inbox cards have a fixed width and height. The physical round panel clips edge previews; blue moves the focused card into the readable middle. Touch scrolling uses LVGL's normal scroll behavior. No row changes size while moving.

The old list changed every card's width in its scroll callback, which triggered text layout. It also kept drawing the hidden character and used a circular clipping layer over the whole screen. Removing those costs raised the same USB scroll check from 5.2–6.2 to 27.4–31.5 rendered frames per second. Three two-second runs used the real connected StopWatch and a 16-agent list. Mean rendering time fell from 108–132 ms to 10–12 ms per frame. These are display measurements, not touch-to-photon latency claims. `maestro.benchmark` repeats the check in a USB snapshot-enabled build; it sends no messages and never changes the selected agent.

Three final runs with 17 agents each rendered 64 frames in 2.02 seconds, about 31.6 fps, with 10.0–10.3 ms mean rendering time. Initial connection and list loading can still cause a slower frame. Reply paging keeps one line of context and ten whole visible lines.

Wake the device before a USB UI check (`w` in the SDK console). USB navigation alone does not dismiss the SDK's sleep cover; physical buttons do. Discard screenshots whose capture tool reports lost bytes from interleaved serial logs.

Bitmap type, pixel symbols, flat cards, square switches and sliders now cover the home screen, picker, inbox, reply reader, settings and keyboard. The fonts reuse the Muse SDK's licensed Adafruit 5×8 bitmap glyphs at integer sizes. `scripts/build-pixel-font.py` creates the checked-in LVGL font data. Unsupported user text retains the shipped font fallback; the native Muse caption keeps its CJK fallback. See `docs/licenses/Pixel-font.txt`.

All portraits come from their full-screen character. Muse and Clawd retain their original pixel animation; Codex keeps the original poses on a fixed pixel grid. Grok uses a round stepped outline and expressive eyes. Pi retains its three-color mark. Dot uses the owner's mint diamond and sunglasses, with an eight-color sprite and small state reactions. See [art sources, generation prompt and encoders](../firmware/src/avatars/SOURCES.md).

Pi's mark now has pixel eyes and a yellow hand: it looks toward speech, scans while thinking, bounces with speech level, reacts to an error, and sleeps. Codex gains a dim sleep pose and rising pixel Z. Clawd uses its existing happy animation on a pet reaction. Grok's silhouette moves only in whole cells to avoid a shimmering rim. Dot's error shake settles, and its glasses glint and sleep state remain on the same pixel grid. Muse's art and animation code are unchanged.

Agent rows separate the provider name from the chat title. The subtitle contains only a known chat title; new chats and companions without titles leave it blank. Connection instructions and project paths no longer take its place.

The native renderer still owns animation, captions, audio levels and touch. Maestro pauses covered drawing while the picker or reader is open. Closing an overlay resumes the current state. Replies, unread badges and grouped alerts retain their existing behavior.
