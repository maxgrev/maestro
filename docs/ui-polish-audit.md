# Mac UI polish audit

Reviewed on November 5, 2026 using better-design, apple-design,
high-end-visual-design, better-writing, and Emil's interaction guidance.
The accepted graphite and sage palette, Avenir Next headings, system body
type, character art, and physical StopWatch proportions remain the design base.

## Changes

| Before | After | Why |
| --- | --- | --- |
| Plus signs and native disclosure triangles mixed across screens | One centered chevron in a fixed trailing slot | Expansion has one visual language. |
| Character alignment depended on negative margins | Fixed portrait slots in setup, lists, headers, and guides | Different character shapes share a clear center. |
| Single-line tips nested inside disclosures | Short help beside the relevant field | Users can read required guidance without extra clicks. |
| Settings expanded below Setup | A separate Settings screen, also available with Command-comma | App preferences have a stable home. |
| Utility back controls always returned to Conversations | Dot and Grok return to Agents; Credits returns to Settings | Back follows the route into the screen. |
| Setup tabs mixed Unicode symbols and shifting widths | Equal segments, centered SVGs, a sliding selection, keyboard navigation | State and alignment remain steady across steps. |
| Dot still said Connect Dot after connecting | Connected heading and Open conversations action | The screen reflects the real state. |
| Load failures could strand a screen | Dot and Grok offer retry; Conversations clears its initial placeholders | Recovery stays in the app. |
| Empty Conversations always asked users to choose a chat | Start a conversation or connect an agent, based on available targets | Empty screens offer an action that can work. |
| Refresh could restore a cleared project folder | Initial prefill runs once | Background updates preserve edits. |
| Copy feedback could shift a button | Reserved button width and accessible feedback | Adjacent fields stay still. |
| Native-looking controls had uneven press and focus feedback | Tonal press state, consistent focus rings, accessible dialog close button | Small controls behave as part of one app. |
| Imported history exposed a synthetic subagent handoff as a user message | The history view omits the known handoff wrapper and keeps the answer | Internal transcript metadata does not interrupt the conversation. |
| New chat listed a saved target from an old project configuration | Only current targets appear, with the configured project name | Users can distinguish the choices and avoid an unusable duplicate. |

## Coverage

The browser preview serves the same HTML, CSS, and JavaScript as the Mac app.
Its device, account, and session responses are simulated. It cannot flash a
watch, grant account access, or send a message to a real agent.

| Screen | Checks |
| --- | --- |
| Device | Connected, no USB device, installation needed, update disclosure, next action |
| Wi-Fi | Connected and disconnected states, inline field help, remote access disclosure, recovery link |
| Agents | All five disclosures, portrait geometry, Muse pairing fields, Grok fields, coding accounts, nested Pi controls, project draft, voice selection and save |
| Try it | Connection rows, device actions, open Conversations, running in the menu bar |
| Conversations | Ready, saved session, working agent, watch-only replies, setup needed, history, terminal output, search, Unread, draft preservation, simulated reply, empty list, no agents, initial load failure |
| New conversation | Pointer open/close, Escape, Command-N, target selection, focus return |
| Settings | Light, dark, System control, setup and credits links |
| Dot | Name form, connection instructions, connected state, missing remote access, consent layout, load failure and retry, stable copy feedback |
| Grok | Guide layout, instruction loading, copy feedback, load failure and retry |
| Credits | Readability, narrow wrapping, parent navigation |
| Legacy routes | Inbox redirect and old Settings anchor remain supported |

Screens were inspected at desktop, 900px, and 390px widths. Main screens were
viewed in light and dark. Expanded forms and error states received focused
checks where their content differed. No horizontal page overflow appeared in
the inspected states. Portrait slots measured 32 by 32px; disclosure chevrons
use a 24px slot. Small glyphs were also checked visually.

Keyboard checks cover setup arrow keys, Home/End, Enter on disclosures,
conversation selection, search, sidebar sizing and visibility, new chat,
Escape, and focus after navigation. Copy checks restore the preview clipboard.
Session connection and replies use simulated targets.

## Motion

Buttons respond on press with a tonal change. They do not lift or shrink.
Setup selection uses a 180ms transform; panels use a 140ms opacity change.
The dialog enters in 180ms and closes in 120ms, using opacity and a small
scale change. Reopening starts from the current presentation value.

Disclosures preserve native details/summary semantics and reverse from the
visible size on a rapid toggle. Height resolves in 200ms on open and 160ms
on close, with no per-frame JavaScript. This is a bounded exception to the
transform/opacity preference: it keeps surrounding form rows moving with the
content. Resize settles the requested state and releases temporary clipping.
Keyboard activation resolves immediately. Focus rings sit inside the summary
so temporary clipping does not cut them off. Collapsing content becomes inert
until the close finishes.

Reduce Motion was exercised in the isolated preview with a preference
override, including static character art and immediate disclosure cleanup.
The actual macOS preference switch was not changed or tested. Increased
contrast remains wired in CSS; OS-level contrast and transparency switching
were not exercised. These screens use solid surfaces rather than glass.

## Verification and limits

TypeScript checking, JavaScript syntax checks, and all 74 existing tests pass.
The native app builds, signs, verifies, and launches using the existing caches.
Native review covers toolbar navigation, Settings, setup disclosures, and the
conversation dialog. Real USB inspection is read-only. Firmware installation,
Wi-Fi writes, account grants, live agent replies, and physical watch controls
are outside this visual pass.

The prior CI run did not receive a hosted Mac runner for its icon job. GitHub
reported arm64 capacity constraints; the Mac build consequently never started.
That failure did not include a compiler or test failure.
