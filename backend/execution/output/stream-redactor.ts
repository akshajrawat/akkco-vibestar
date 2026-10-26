// State is private to one stream. Only the bounded ambiguous prefix is retained;
// recognized values are suppressed incrementally, regardless of their length.
const fields = [
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "accesstoken",
  "access_token",
  "access-token",
  "refreshtoken",
  "refresh_token",
  "refresh-token",
  "oauthtoken",
  "oauth_token",
  "oauth-token",
  "cookie",
  "set-cookie",
];
const tokens = ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "ya29."];
const prefixes = [...fields, ...tokens];

export class StreamRedactor {
  private input = "";
  private pending: { raw: string; value: string }[] = [];
  private mode: "plain" | "separator" | "value" | "token" | "opaque" = "plain";
  private field = "";
  private separated = false;
  private scheme = "";
  private firstWord = true;
  private afterScheme = false;
  private osc = false;
  private output = "";
  private previous = "";

  private consume = (raw: string, value: string) => {
    if (this.mode === "opaque") {
      if (!/^[\r\n]$/.test(value)) return;
      this.mode = "plain";
    }
    if (!value) {
      if (this.pending.length) {
        if (this.pending.length >= 64) {
          this.pending = [];
          this.mode = "opaque";
          this.output += "[REDACTED]";
        } else this.pending.push({ raw, value });
      } else this.output += raw;
      return;
    }
    if (this.mode === "token") {
      if (/^[a-z0-9_.-]$/i.test(value)) return;
      this.mode = "plain";
    }
    if (this.mode === "value") {
      if (this.afterScheme && /^[ \t]$/.test(value)) return;
      this.afterScheme = false;
      const cookie = this.field === "cookie" || this.field === "set-cookie";
      if (/^[\r\n"']$/.test(value) || (!cookie && /^[\s,;}\]]$/.test(value))) {
        if (
          this.field === "authorization" &&
          this.firstWord &&
          /^[ \t]$/.test(value) &&
          /^(bearer|basic|token|digest)$/i.test(this.scheme)
        ) {
          this.firstWord = false;
          this.afterScheme = true;
          return;
        }
        this.mode = "plain";
      } else {
        if (this.scheme.length < 16) this.scheme += value;
        return;
      }
    }
    if (this.mode === "separator") {
      if (/^[ \t"':=]$/.test(value)) {
        this.separated = true;
        this.output += raw;
        this.previous = value;
        return;
      }
      if (this.separated && !/^[\r\n,;}\]]$/.test(value)) {
        this.output += "[REDACTED]";
        this.mode = "value";
        this.scheme = value;
        this.firstWord = true;
        this.afterScheme = false;
        return;
      }
      this.mode = "plain";
    }
    this.pending.push({ raw, value });
    while (this.pending.length) {
      const text = this.pending
        .map((unit) => unit.value)
        .join("")
        .toLowerCase();
      const candidates = /[a-z0-9_]/i.test(this.previous) ? fields : prefixes;
      if (candidates.includes(text) && tokens.includes(text)) {
        this.output += "[REDACTED]";
        this.pending = [];
        this.mode = "token";
        return;
      }
      if (fields.includes(text)) {
        this.output += this.pending.map((unit) => unit.raw).join("");
        this.pending = [];
        this.field = text;
        this.previous = text.at(-1)!;
        this.separated = false;
        this.mode = "separator";
        return;
      }
      if (candidates.some((prefix) => prefix.startsWith(text))) return;
      const unit = this.pending.shift()!;
      this.output += unit.raw;
      if (unit.value) this.previous = unit.value;
    }
  };

  push = (chunk: string) => {
    const text = this.input + chunk;
    this.input = "";
    this.output = "";
    let offset = 0;
    while (offset < text.length) {
      const remaining = text.slice(offset);
      if (this.osc || remaining.startsWith("\x1b]")) {
        const end = remaining.search(/\x07|\x1b\\/);
        if (end < 0) {
          this.osc = true;
          // Keep only a possible split ESC terminator, never OSC payload.
          this.input = remaining.endsWith("\x1b") ? "\x1b" : "";
          break;
        }
        this.osc = false;
        offset += end + (remaining[end] === "\x07" ? 1 : 2);
        continue;
      }
      if (remaining[0] === "\x1b") {
        const ansi = remaining.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
        if (ansi) {
          this.consume(ansi, "");
          offset += ansi.length;
          continue;
        }
        if (remaining.length < 256 && (remaining.length === 1 || remaining.startsWith("\x1b["))) {
          this.input = remaining;
          break;
        }
        offset += Math.min(remaining.length, remaining.startsWith("\x1b[") ? 256 : 2);
        continue;
      }
      if (remaining[0] === "\\") {
        const length = remaining[1] === "u" ? 6 : remaining[1] === "x" ? 4 : 2;
        if (remaining.length < length) {
          this.input = remaining;
          break;
        }
        const escaped = remaining.slice(0, length);
        if (/^\\u[\da-f]{4}$/i.test(escaped) || /^\\x[\da-f]{2}$/i.test(escaped)) {
          this.consume(escaped, String.fromCharCode(parseInt(escaped.slice(2), 16)));
          offset += length;
          continue;
        }
        if (length === 2) {
          const value =
            ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped[1]] || escaped[1];
          this.consume(escaped, value);
          offset += 2;
          continue;
        }
      }
      const point = text.codePointAt(offset)!;
      if (point >= 0xd800 && point <= 0xdbff && offset + 1 === text.length) {
        this.input = text[offset];
        break;
      }
      const value = String.fromCodePoint(point);
      this.consume(value, value);
      offset += value.length;
    }
    return this.output;
  };

  finish = (preserveIncomplete = false) => {
    // An unresolved token/key/escape prefix is never flushed as raw text.
    const tail = preserveIncomplete
      ? this.pending.map((unit) => unit.raw).join("") + this.input
      : this.pending.length || this.input
        ? "[REDACTED]"
        : "";
    this.pending = [];
    this.input = "";
    this.mode = "plain";
    this.osc = false;
    return tail;
  };
}
