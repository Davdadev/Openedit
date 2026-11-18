/**
 * Sanitiser for user / Figma-derived template markup. Compositions must be
 * deterministic and self-contained: no scripts (motion comes from the declarative
 * preset spec), no event handlers, no remote assets (pass local files in `assets`),
 * no frames/forms/media elements. Google Fonts links/@imports are collected so the
 * fonts can be downloaded into the template (see fonts localisation in create.ts).
 */

export interface SanitizeResult {
  html: string;
  css: string;
  warnings: string[];
  /** Google Fonts stylesheet URLs found (links and @imports). */
  googleFonts: string[];
}

const GOOGLE_CSS = /^https:\/\/fonts\.googleapis\.com\/css2?\?/i;
const BLOCKED_TAGS = ["script", "iframe", "object", "embed", "frame", "frameset", "base", "meta", "form", "input", "button", "textarea", "select", "audio", "video", "portal", "noscript", "template"];

function stripRemoteUrls(css: string, warnings: string[], what: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, url: string) => {
    const u = url.trim();
    if (/^(https?:)?\/\//i.test(u)) {
      if (/^https:\/\/fonts\.gstatic\.com\//i.test(u)) return m;
      warnings.push(`${what}: remote url(${u}) removed — download it and pass it in assets, then reference "assets/<file>"`);
      return "none";
    }
    if (/^javascript:/i.test(u)) return "none";
    return m;
  });
}

export function sanitizeCss(css: string, warnings: string[], googleFonts: string[]): string {
  let out = css.replace(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/gi, (_m, url: string) => {
    if (GOOGLE_CSS.test(url)) googleFonts.push(url);
    else warnings.push(`css: @import ${url} removed (only Google Fonts imports are allowed)`);
    return "";
  });
  out = out.replace(/expression\s*\(/gi, "(").replace(/behavior\s*:/gi, "x-behavior:").replace(/-moz-binding/gi, "x-binding");
  out = out.replace(/<\/style/gi, "<\\/style");
  return stripRemoteUrls(out, warnings, "css");
}

/** Sanitise an HTML/SVG fragment. Full documents are reduced to their <body> (head styles kept). */
export function sanitizeFragment(input: string, cssIn = ""): SanitizeResult {
  const warnings: string[] = [];
  const googleFonts: string[] = [];
  let html = String(input ?? "");
  let css = String(cssIn ?? "");

  // Full document → styles from <head> + body content.
  if (/<html[\s>]|<body[\s>]|<!doctype/i.test(html)) {
    const head = /<head[\s>][\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
    html = head.replace(/<title[\s\S]*?<\/title>/gi, "") + (body ?? html.replace(/<!doctype[^>]*>|<\/?html[^>]*>|<\/?head[^>]*>/gi, ""));
  }
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // <style> blocks → css (sanitised together).
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, s: string) => {
    css += `\n${s}`;
    return "";
  });
  // <link rel=stylesheet>: Google Fonts only.
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    if (GOOGLE_CSS.test(href.replace(/&amp;/g, "&"))) googleFonts.push(href.replace(/&amp;/g, "&"));
    else if (!/rel\s*=\s*["']?(preconnect|dns-prefetch)/i.test(tag)) warnings.push(`<link href="${href}"> removed (only Google Fonts stylesheets are allowed)`);
    return "";
  });
  for (const tag of BLOCKED_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const single = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    if (paired.test(html) || single.test(html)) {
      warnings.push(`<${tag}> removed${tag === "script" ? " (animate with the motion presets instead; compositions run no custom scripts)" : ""}`);
      html = html.replace(paired, "").replace(single, "");
    }
  }
  // Event handlers and javascript: URLs.
  html = html.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
    warnings.push("inline event handler removed");
    return "";
  });
  html = html.replace(/\s(href|src|xlink:href|action|formaction|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr: string, _q, a?: string, b?: string) => {
    const v = (a ?? b ?? "").trim();
    if (/^(javascript|vbscript):/i.test(v) || /^data:text\/html/i.test(v)) {
      warnings.push(`${attr}="${v.slice(0, 30)}…" removed`);
      return "";
    }
    if (/^(https?:)?\/\//i.test(v) && !/^#/.test(v)) {
      warnings.push(`remote ${attr}="${v}" removed — download it, pass it in assets and use "assets/<file>"`);
      return ` ${attr}=""`;
    }
    return m;
  });
  // Inline style attributes: remote url() and expression().
  html = html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (_m, _q, a?: string, b?: string) => {
    const v = stripRemoteUrls(a ?? b ?? "", warnings, "style").replace(/expression\s*\(/gi, "(");
    return ` style="${v.replace(/"/g, "&quot;")}"`;
  });
  css = sanitizeCss(css, warnings, googleFonts);
  return { html: html.trim(), css: css.trim(), warnings: [...new Set(warnings)], googleFonts: [...new Set(googleFonts)] };
}
