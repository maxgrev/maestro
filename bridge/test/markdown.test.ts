import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';

test('replies render Markdown while keeping HTML, image trackers and executable URLs inert', () => {
  const html = renderMarkdown('# Result\n\n- **Done**\n- `x < 3`\n\n[Docs](https://example.com/?a=1&b=2)\n\n<script>alert(1)</script>\n\n![spy](https://evil.test/pixel)\n\n[bad](javascript:alert%281%29)\n\n[encoded](jav&#x61;script:alert%281%29)');
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<li><strong>Done<\/strong><\/li>/);
  assert.match(html, /<code>x &lt; 3<\/code>/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):|evil\.test/);
  assert.match(html, /\[spy\]/);
});
