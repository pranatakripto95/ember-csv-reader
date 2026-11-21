// Ember CSV Reader — a faster drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as csv-reader 1.0.0 on every input, including broken CSV
// (unclosed quotes, stray CRs, quote junk, short/long rows), but built for
// speed: the reference walks the text one character at a time and builds
// every field with `value += c`. This reader instead:
//
//   - takes a fast path per record: when a record's line holds no double
//     quote at all, the whole line is split natively on ',' in one go;
//   - otherwise reads field by field, jumping between delimiters with
//     indexOf (native scans) instead of stepping character by character;
//   - finds a quoted field's closing quote with indexOf, slices its
//     content out whole, and only transforms it ("" -> ", CR/CRLF -> LF)
//     when the content actually holds those sequences;
//   - never allocates per character: field values are slices (or a split)
//     of the input, joined only when stray CRs have to be dropped.
//
// Semantics follow csv-reader 1.0.0 exactly (see the kit's
// baselines/csv-reader/vendor/csv-reader/index.js):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no
//     record; outside quotes a CR not followed by LF is dropped
//     (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when the
//     field ends); a quote that never closes is a literal character, and
//     the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields
//     stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it, each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the
//     1-based line its record starts on, counting every LF, CRLF and lone
//     CR inside quotes, and row its record's index in rows (null for the
//     header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// One native scan for the next field delimiter (comma, CR or LF). Shared
// across calls; lastIndex is set before every exec.
const DELIM_RE = /[,\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows
  // it takes (null: the header). Errors raised while reading it use these.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters from pos, starting from `prefix` as the
  // field's value so far ('' for a fresh field, the quoted value for
  // quote junk, '"' for an unterminated quote re-read as unquoted).
  // Returns {v, e, added}: the field, how it ended, and how many
  // characters were kept after the prefix.
  function readUnquoted(prefix) {
    let parts = null; // segments kept, only built when a stray CR is met
    let segStart = pos;
    let added = 0;
    for (;;) {
      DELIM_RE.lastIndex = pos;
      const m = DELIM_RE.exec(text);
      if (m === null) {
        if (parts === null) {
          added += n - segStart;
          pos = n;
          return { v: prefix + text.slice(segStart, n), e: END, added };
        }
        parts.push(text.slice(segStart, n));
        added += n - segStart;
        pos = n;
        return { v: prefix + parts.join(''), e: END, added };
      }
      const d = m.index;
      const code = m[0].charCodeAt(0);
      if (code === 44) {
        if (parts === null) {
          added += d - segStart;
          pos = d + 1;
          return { v: prefix + text.slice(segStart, d), e: COMMA, added };
        }
        parts.push(text.slice(segStart, d));
        added += d - segStart;
        pos = d + 1;
        return { v: prefix + parts.join(''), e: COMMA, added };
      }
      if (code === 10) {
        if (parts === null) {
          added += d - segStart;
          pos = d + 1;
          line += 1;
          return { v: prefix + text.slice(segStart, d), e: LINE_BREAK, added };
        }
        parts.push(text.slice(segStart, d));
        added += d - segStart;
        pos = d + 1;
        line += 1;
        return { v: prefix + parts.join(''), e: LINE_BREAK, added };
      }
      // A CR: CRLF is a line break, a lone CR is dropped (stray_cr).
      if (text.charCodeAt(d + 1) === 10) {
        if (parts === null) {
          added += d - segStart;
          pos = d + 2;
          line += 1;
          return { v: prefix + text.slice(segStart, d), e: LINE_BREAK, added };
        }
        parts.push(text.slice(segStart, d));
        added += d - segStart;
        pos = d + 2;
        line += 1;
        return { v: prefix + parts.join(''), e: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, d));
      added += d - segStart;
      pos = d + 1;
      segStart = d + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let searchFrom = pos + 1;
    let hasDoubled = false;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', searchFrom);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        hasDoubled = true;
        searchFrom = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. The line is rewound first,
      // so line breaks met inside the would-be quoted field are counted
      // once, by the unquoted re-read (a lone CR there is a stray CR,
      // not a line break).
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    let value = text.slice(open + 1, close);
    // Line breaks inside the quotes count, and CRLF / lone CR read as LF.
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      const breaks = value.match(/\r\n|\r|\n/g);
      if (breaks !== null) line += breaks.length;
      value = value.replace(/\r\n?/g, '\n');
    }
    if (hasDoubled) value = value.replaceAll('""', '"');
    pos = close + 1;
    if (pos >= n) return { v: value, e: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { v: value, e: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { v: value, e: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { v: value, e: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Finishes a record read into `fields` (quoted: whether its last field
  // was quoted): pads or cuts it to the first record's width, records
  // short_row / long_row, and stores it — unless it is a line left with
  // no characters, which is no record.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's first line holds no field that opens with
    // a quote, so no field of this record is quoted and the record ends
    // at this line's break. Split the line natively instead of reading
    // it field by field. A stray CR inside the line is dropped with its
    // error; a CRLF's CR is the line break itself and is not stray.
    // The quote test scans the line for '"' (a '"' opens a field only
    // at the line's start or right after a comma), so no scan ever runs
    // past the line.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    const isCRLF = lf !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13;
    const segEnd = isCRLF ? lineEnd - 1 : lineEnd;
    const segment = text.slice(pos, segEnd);
    let hasQuote = false;
    let from = 0;
    for (;;) {
      const qi = segment.indexOf('"', from);
      if (qi === -1) break;
      if (qi === 0 || segment.charCodeAt(qi - 1) === 44) {
        hasQuote = true;
        break;
      }
      from = qi + 1;
    }
    if (!hasQuote) {
      const fields = segment.split(',');
      if (segment.indexOf('\r') !== -1) {
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          if (f.indexOf('\r') !== -1) {
            let count = 0;
            for (let j = 0; j < f.length; j++) if (f.charCodeAt(j) === 13) count += 1;
            for (let k = 0; k < count; k++) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            fields[i] = f.replaceAll('\r', '');
          }
        }
      }
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // Slow path: the record holds a quote, so read it field by field.
    const slowFields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      slowFields.push(field.v);
    } while (field.e === COMMA);
    finishRecord(slowFields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
