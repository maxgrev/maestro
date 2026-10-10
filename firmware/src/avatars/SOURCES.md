# Character sources

- **Muse:** the native Muse Gadget SDK animation. Maestro leaves its renderer intact.
- **Claude:** Clawd Tank by Marcio Granzotto Rodrigues, commit `a8942d140eeb8bcf549857ad599f7d62fd29eb01`, https://github.com/marciogranzotto/clawd-tank. The six sprite headers and RLE decoder are unchanged upstream files. MIT license: `Clawd-LICENSE.txt`. This is a community animation of Clawd, not a claim of Anthropic endorsement.
- **Codex:** the original OpenAI Codex companion, `codex-spritesheet-v6-51045ae208c0.webp`, from the user's installed Codex app. `scripts/build-codex-sprites.py` converts selected rows to RGB565 without redrawing them. The original file is in `bridge/public/characters/codex.webp`. This asset is not covered by Clawd's MIT license; this repository and app are private personal builds. Obtain redistribution permission before a public release that includes it.
- **Grok Bot:** Maestro's procedural animation of the round black character and white eyes in the user's reference. Its motion and AMOLED outline are Maestro adaptations, not an official xAI animation. Listening, thinking, speaking, error, sleep, and pet/completion poses use the existing SDK state. The expressive-eye approach is informed by Novra’s independent concept at https://www.novra.design/case-studies/grokbot; no Novra/Rive files are bundled.
- **Pi:** the official three-color mark from https://pi.dev/logo-auto.svg (retrieved 2026-10-09). The firmware reproduces its geometry and adds small movement. It is a logo, not an official character.

Frame mapping: Codex idle (row 0), speaking/wave (3), thinking/run (7), error (5), listening/wait (6). Clawd uses idle, alert, thinking, happy, confused, and sleeping. The SDK's state selects the animation.

Added characters render on a 320×320 canvas. Codex keeps its original 192×208 frames; Clawd uses a constant 2× integer scale. Grok draws smooth edges at display resolution, and Pi uses whole-pixel geometry. Each frame invalidates the full character area: Muse's 64×64 cell damage tracker only applies to Muse.
