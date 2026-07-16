const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "title",
  "desc",
]);

const SVG_ATTRIBUTES = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-dasharray",
  "opacity",
  "transform",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "id",
  "role",
  "aria-label",
]);

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Conservatively rebuilds a non-interactive SVG subset with no URL-bearing features. */
export function sanitizeNotebookSvg(input: string): string {
  const withoutActiveContent = input
    .replace(
      /<\s*(script|foreignObject|style|iframe|object|embed|a|use|image|animate|set)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    )
    .replace(
      /<\s*(script|foreignObject|style|iframe|object|embed|a|use|image|animate|set)\b[^>]*\/?\s*>/gi,
      "",
    )
    .replace(/<![\s\S]*?>|<\?[\s\S]*?\?>/g, "");
  const tokenPattern = /<\s*(\/?)\s*([A-Za-z][\w.-]*)([^>]*)>/g;
  const result: string[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(withoutActiveContent)) !== null) {
    const between = withoutActiveContent.slice(cursor, match.index);
    if (between.includes("<") || between.includes(">")) return "";
    if (stack.length > 0 && between.length > 0) result.push(escapeXml(between));
    cursor = tokenPattern.lastIndex;

    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const rawAttributes = match[3] ?? "";
    if (!SVG_ELEMENTS.has(name)) continue;
    if (closing) {
      if (stack.at(-1) !== name) return "";
      stack.pop();
      result.push(`</${name}>`);
      continue;
    }

    const attributes: string[] = [];
    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attributeSource = rawAttributes.replace(/\/\s*$/, "");
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attributeCursor = 0;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(attributeSource)) !== null) {
      if (attributeSource.slice(attributeCursor, attributeMatch.index).trim().length > 0) return "";
      attributeCursor = attributePattern.lastIndex;
      const attributeName = (attributeMatch[1] ?? "").toLowerCase();
      const attributeValue = attributeMatch[2] ?? attributeMatch[3] ?? "";
      if (
        SVG_ATTRIBUTES.has(attributeName) &&
        !attributeName.startsWith("on") &&
        !/(?:url\s*\(|javascript:|data:|https?:|\/\/)/i.test(attributeValue)
      ) {
        attributes.push(`${attributeName}="${escapeXml(attributeValue)}"`);
      }
    }
    if (attributeSource.slice(attributeCursor).trim().length > 0) return "";
    result.push(
      `<${name}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}${selfClosing ? "/" : ""}>`,
    );
    if (!selfClosing) stack.push(name);
  }

  const trailing = withoutActiveContent.slice(cursor);
  if (trailing.includes("<") || trailing.includes(">")) return "";
  if (stack.length > 0 && trailing.length > 0) result.push(escapeXml(trailing));
  if (stack.length !== 0) return "";
  const sanitized = result.join("");
  return /^<svg\b/i.test(sanitized) && /<\/svg>$|<svg\b[^>]*\/>$/i.test(sanitized) ? sanitized : "";
}

const sanitizeSandboxedHtml = (input: string): string =>
  input
    .replace(
      /<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    )
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s(?:on[a-z]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:src|href|action|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/style\s*=\s*(?:"[^"]*url\s*\([^)]*\)[^"]*"|'[^']*url\s*\([^)]*\)[^']*')/gi, "");

export const sandboxedNotebookHtmlDocument = (input: string): string => `<!doctype html>
<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${sanitizeSandboxedHtml(input)}</body></html>`;
