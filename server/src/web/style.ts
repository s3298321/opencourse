/**
 * The web catalog's stylesheet, served from /static/style.css. Kept in the
 * bundle as a string so dist/ is one file to deploy. Neutral, readable, and in
 * both colour schemes - the page belongs to whoever runs the server.
 */
export const STYLE = `
:root {
  --bg: #fafafa; --fg: #1d1d21; --muted: #62626b; --card: #ffffff; --border: #e3e3e8;
  --accent: #2f5bd3; --chip: #f0f0f3; --chip-on: #1d1d21; --chip-on-fg: #ffffff;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18181b; --fg: #dedee3; --muted: #a5a5af; --card: #202024; --border: #393940; --accent: #8fb0ff; --chip: #2b2b30; --chip-on: #e4e4e8; --chip-on-fg: #202024; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 16px; }
header.site { border-bottom: 1px solid var(--border); background: var(--card); }
header.site .wrap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding-top: 18px; padding-bottom: 18px; }
.brand { font-size: 20px; font-weight: 700; color: var(--fg); text-decoration: none; }
.tagline { color: var(--muted); }
main { padding-top: 24px; padding-bottom: 32px; }
footer { color: var(--muted); font-size: 13px; padding-bottom: 32px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.search { display: flex; flex-wrap: wrap; gap: 8px; }
.search input[type=search] { flex: 1 1 260px; min-width: 0; }
input, select, button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); }
button { background: var(--fg); color: var(--bg); border-color: var(--fg); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.chip { padding: 3px 10px; border-radius: 999px; background: var(--chip); color: var(--fg); text-decoration: none; font-size: 13px; }
.chip span { color: var(--muted); margin-left: 2px; }
.chip.on { background: var(--chip-on); color: var(--chip-on-fg); }
.chip.on span { color: inherit; opacity: 0.7; }
.count { color: var(--muted); margin: 16px 0 10px; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.card a { display: flex; flex-direction: column; height: 100%; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--card); color: var(--fg); text-decoration: none; }
.card a:hover { border-color: var(--muted); }
.card img, .cover-blank { width: 100%; aspect-ratio: 16 / 7; object-fit: cover; background: var(--chip); display: block; }
.card-body { padding: 12px 14px 14px; }
.card h2 { font-size: 17px; margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.summary { margin: 8px 0 0; font-size: 14px; }
.stats { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
.tag { padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--fg); font-size: 12px; text-decoration: none; }
.pager { display: flex; justify-content: center; align-items: center; gap: 16px; margin-top: 24px; }
.back { margin: 0 0 12px; }
.course { max-width: 760px; }
.course .cover { width: 100%; max-height: 320px; object-fit: cover; border-radius: 12px; border: 1px solid var(--border); }
.course h1 { margin: 16px 0 6px; font-size: 28px; line-height: 1.2; }
.course section { margin-top: 24px; }
.course h2 { font-size: 18px; margin: 0 0 8px; }
.prose { overflow-wrap: anywhere; }
.prose pre { overflow-x: auto; padding: 12px; background: var(--chip); border-radius: 8px; }
.outline { padding-left: 22px; }
.outline > li { margin-bottom: 8px; }
.outline ol { padding-left: 20px; margin: 4px 0 0; }
.mins { color: var(--muted); font-size: 13px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--chip); color: var(--muted); vertical-align: 1px; }
.versions { list-style: none; padding: 0; }
.versions li { padding: 10px 0; border-top: 1px solid var(--border); }
.versions p { margin: 4px 0 0; }
`
