// Static checks for the ExtendScript host files.
//
//   node premiere/test/check-host.mjs
//
//  * every file under host/ is pure 7-bit ASCII (ExtendScript reads scripts
//    in the system code page on Windows)
//  * every file parses (new Function after dropping #include lines)
//  * no obvious post-ES3 constructs (let/const, arrows, template strings,
//    ES5 array/object helpers, trailing commas)
//  * when the `acorn` parser can be resolved (normal require, or the
//    ACORN_PATH env var pointing at an acorn package), a strict ES3 parse
// Also checks that the panel-side files are ASCII.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const hostDir = path.join(root, "host");
const require = createRequire(import.meta.url);

let acorn = null;
for (const id of [process.env.ACORN_PATH, "acorn"].filter(Boolean)) {
  try {
    acorn = require(id);
    break;
  } catch (e) {
    // optional
  }
}

// Strip comments, strings and regex literals well enough for the lint regexes.
function codeOnly(src) {
  let out = "";
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2);
      i = i < 0 ? src.length : i + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      prev = '"';
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};]/.test(prev)) {
      i++;
      let inClass = false;
      while (i < src.length && (src[i] !== "/" || inClass)) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        i++;
      }
      i++;
      while (/[gimy]/.test(src[i] || "")) i++;
      out += "/r/";
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const FORBIDDEN = [
  [/\blet\s/, "let"],
  [/\bconst\s/, "const"],
  [/=>/, "arrow function"],
  [/`/, "template literal"],
  [/\.(forEach|map|filter|reduce|some|every)\s*\(/, "ES5 array method"],
  [/\bObject\.(keys|create|defineProperty|getPrototypeOf)\b/, "ES5 Object helper"],
  [/\bArray\.isArray\b/, "Array.isArray"],
  [/\.trim\s*\(/, "String.prototype.trim"],
  [/\bDate\.now\b/, "Date.now"],
  [/,\s*[}\]]/, "trailing comma"],
];

let problems = 0;
function report(file, msg) {
  problems++;
  console.log(`  FAIL ${path.relative(root, file)}: ${msg}`);
}

function checkAscii(file) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7e || (buf[i] < 0x20 && buf[i] !== 0x0a && buf[i] !== 0x0d && buf[i] !== 0x09)) {
      const line = buf.subarray(0, i).toString("latin1").split("\n").length;
      report(file, `non-ASCII byte 0x${buf[i].toString(16)} at line ${line}`);
      return false;
    }
  }
  return true;
}

const jsxFiles = fs.readdirSync(hostDir).filter((f) => f.endsWith(".jsx")).map((f) => path.join(hostDir, f));
console.log(`host files: ${jsxFiles.map((f) => path.basename(f)).join(", ")}`);
console.log(acorn ? `acorn ${acorn.version}: strict ES3 parse enabled` : "acorn not found: ES3 parse skipped (set ACORN_PATH)");

for (const file of jsxFiles) {
  checkAscii(file);
  const src = fs.readFileSync(file, "utf8").replace(/^\s*#(include|target|targetengine).*$/gm, "");
  try {
    new Function(src);
  } catch (e) {
    report(file, "syntax error: " + e.message);
    continue;
  }
  if (acorn) {
    try {
      acorn.parse(src, { ecmaVersion: 3, sourceType: "script", allowReserved: true });
    } catch (e) {
      report(file, "not ES3: " + e.message);
    }
  }
  const code = codeOnly(src).split("\n");
  code.forEach((line, idx) => {
    for (const [re, what] of FORBIDDEN) {
      if (re.test(line)) {
        report(file, `line ${idx + 1}: ${what}: ${line.trim()}`);
      }
    }
  });
}

for (const f of ["index.html", "panel.js", "lib/server.js", "CSXS/manifest.xml", "install.sh", "uninstall.sh", "install.ps1"]) {
  checkAscii(path.join(root, f));
}

console.log(problems ? `${problems} problem(s)` : "host checks passed");
process.exit(problems ? 1 : 0);
