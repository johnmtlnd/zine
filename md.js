/* ============================================================
   MARKDOWN — the small, safe kind
   Posts are stored as plain text and rendered here. The input is
   HTML-escaped before anything else happens, and the only tags that
   can come out are the ones this file writes, so nothing typed into
   a post can inject markup. Links are limited to http(s) and mailto.

   Supported, because these are the ones people actually type:
     # ## ###     headings          **bold**  __bold__
     - * +        bullet lists      *italic*  _italic_
     1. 1)        numbered lists    ~~struck~~
     > quote                        `code`    ``` fenced code ```
     ---          a rule            [text](https://…)  bare https://…
   A single newline is a line break; a blank line starts a paragraph.
   ============================================================ */

const esc = (s) => s
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const safeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(u) ? u : null;

/* inline: runs on already-escaped text */
function inline(s) {
  const keep = [];
  const stash = (html) => `\u0000${keep.push(html) - 1}\u0000`;

  // code first, so nothing inside it is touched
  s = s.replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${c}</code>`));
  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = safeUrl(url.replace(/&amp;/g, "&"));
    return u ? stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${text}</a>`) : m;
  });
  // bare links
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) =>
    pre + stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

  s = s
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]*?\S)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([^~]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

export function md(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const isBlank = (l) => /^\s*$/.test(l);
  const isUl = (l) => /^\s{0,3}[-*+]\s+/.test(l);
  const isOl = (l) => /^\s{0,3}\d{1,3}[.)]\s+/.test(l);
  const isQuote = (l) => /^\s{0,3}>/.test(l);
  const isHead = (l) => /^\s{0,3}#{1,6}\s+\S/.test(l);
  const isRule = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const isFence = (l) => /^\s{0,3}```/.test(l);
  const startsBlock = (l) => isUl(l) || isOl(l) || isQuote(l) || isHead(l) || isRule(l) || isFence(l);

  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }

    if (isFence(l)) {
      const code = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end)
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (isRule(l)) { out.push("<hr>"); i++; continue; }
    if (isHead(l)) {
      const [, hashes, text] = l.trim().match(/^(#{1,6})\s+(.*?)\s*#*$/);
      const lvl = Math.min(hashes.length + 2, 5);   // # → h3: the post title is the h2
      out.push(`<h${lvl}>${inline(esc(text))}</h${lvl}>`);
      i++; continue;
    }
    if (isQuote(l)) {
      const q = [];
      while (i < lines.length && isQuote(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      out.push(`<blockquote>${md(q.join("\n"))}</blockquote>`);
      continue;
    }
    if (isUl(l) || isOl(l)) {
      const ordered = isOl(l);
      const items = [];
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        let item = lines[i++].replace(ordered ? /^\s{0,3}\d{1,3}[.)]\s+/ : /^\s{0,3}[-*+]\s+/, "");
        // indented lines continue the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
          item += "\n" + lines[i++].trim();
        }
        items.push(`<li>${inline(esc(item)).replace(/\n/g, "<br>")}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
    out.push(`<p>${para.map((p) => inline(esc(p))).join("<br>")}</p>`);
  }
  return out.join("");
}

/* Plain text with the markup taken out, for excerpts and previews. */
export function plain(src) {
  return String(src || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/gm, "")
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
