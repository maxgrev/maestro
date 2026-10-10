import { Marked, Renderer } from 'marked';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const renderer = new Renderer();
renderer.html = ({ text }) => escape(text);
renderer.image = ({ text }) => `[${escape(text)}]`; // Replies never load remote image trackers.
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  let url: URL;
  try { url = new URL(href); } catch { return label; }
  if (!['https:', 'http:'].includes(url.protocol)) return label;
  return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
};
const markdown = new Marked({ renderer, gfm: true, async: false });
export const renderMarkdown = (source: string): string => markdown.parse(source) as string;
