// Match credential representations, never decode/rewrite unrelated payload bytes.
// Two per-character layers of UTF-8 percent/form or JSON escaping are supported,
// plus one JSON serialization layer (for provider JSON response envelopes).
export function credentialRedactor(secret: string): (text: string) => string {
  if (!secret) return text => text;
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cache = new Map<string, string>();
  const character = (c: string, depth: number): string => {
    if (!depth) return literal(c);
    const id = depth + ":" + c;
    const cached = cache.get(id);
    if (cached) return cached;
    const sequence = (s: string) => Array.from(s, part => character(part, depth - 1)).join("");
    const alternatives = [literal(c)];
    // Encode every character, including ones encodeURIComponent normally leaves alone.
    const percent = Array.from(Buffer.from(c), b => "%" + b.toString(16).padStart(2,"0"));
    alternatives.push(percent.map(byte => sequence("%") + Array.from(byte.slice(1), digit => {
      const choices = new Set([digit.toLowerCase(), digit.toUpperCase()]);
      return "(?:" + Array.from(choices, d => character(d, depth - 1)).join("|") + ")";
    }).join("")).join(""));
    const unicode = c.split("").map(unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4,"0"));
    // JSON hex digits are case insensitive too, without making raw key letters so.
    alternatives.push(unicode.map(unit => sequence("\\u") + Array.from(unit.slice(2), digit => {
      const choices = new Set([digit.toLowerCase(), digit.toUpperCase()]);
      return "(?:" + Array.from(choices, d => character(d, depth - 1)).join("|") + ")";
    }).join("")).join(""));
    const short = JSON.stringify(c).slice(1,-1);
    if (short !== c) alternatives.push(sequence(short));
    if (c === "/") alternatives.push(sequence("\\/"));
    if (c === " ") alternatives.push(sequence("+"));
    const result = "(?:" + alternatives.join("|") + ")";
    cache.set(id,result);
    return result;
  };
  const pattern = new RegExp(Array.from(secret, c => character(c,2)).join(""), "g");
  return text => {
    const spans: Array<[number, number]> = [];
    const collect = (view: string, starts?: number[], ends?: number[]) => {
      pattern.lastIndex = 0;
      for (const match of view.matchAll(pattern)) {
        const start = match.index!, end = start + match[0].length;
        spans.push([starts ? starts[start] : start, ends ? ends[end - 1] : end]);
      }
    };
    collect(text);
    // A single bounded JSON unescape view with offsets back to original bytes.
    // This is not JSON parsing: invalid/unrelated text remains byte-for-byte intact.
    const escape = /\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g;
    let view = "", previous = 0;
    const starts: number[] = [], ends: number[] = [];
    const append = (s: string, start: number, end?: number) => {
      view += s;
      for (let i=0;i<s.length;i++) { starts.push(end === undefined ? start+i : start); ends.push(end === undefined ? start+i+1 : end); }
    };
    for (const match of text.matchAll(escape)) {
      append(text.slice(previous,match.index),previous);
      append(JSON.parse('"' + match[0] + '"'),match.index!,match.index!+match[0].length);
      previous = match.index! + match[0].length;
    }
    if (previous) { append(text.slice(previous),previous); collect(view,starts,ends); }
    if (!spans.length) return text;
    spans.sort((a,b)=>a[0]-b[0]);
    const merged: Array<[number,number]> = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1],span[1]); else merged.push([...span]);
    }
    let result = "", offset = 0;
    for (const [start,end] of merged) { result += text.slice(offset,start) + "[REDACTED]"; offset=end; }
    return result + text.slice(offset);
  };
}
