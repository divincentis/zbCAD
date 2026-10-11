// ---------------------------------------------------------------------------
// Inflate
//
// DEFLATE decompression (RFC 1951), with the zlib wrapper (RFC 1950) skipped
// when it is there. A PDF compresses nearly everything worth reading with
// FlateDecode, so the reader in model/pdfRead.js cannot start without this.
//
// The browser has DecompressionStream, and it is not used, for two reasons.
// It is asynchronous, which would make every step of reading a PDF a promise
// for the sake of one call; and it does not exist in the headless test
// environment, which would leave the whole PDF path untestable. Written out it
// is a page of code with no dependencies and nothing to wait for.
// ---------------------------------------------------------------------------

const INFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const INFLATE_LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const INFLATE_DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const INFLATE_DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
// The order the code-length code lengths arrive in, which is by how likely
// each is to be used rather than by value.
const INFLATE_CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A Huffman code as a flat lookup: index it with the next `bits` bits of input
// and it answers with the symbol and how many of those bits the symbol really
// used, packed as (symbol << 4) | length. One table read per symbol is what
// keeps a multi-megabyte content stream from taking seconds.
function inflateTable(lengths, count) {
  let bits = 0;
  for (let symbol = 0; symbol < count; symbol++) if (lengths[symbol] > bits) bits = lengths[symbol];
  const table = new Uint16Array(1 << bits);
  const lengthCount = new Uint16Array(16);
  for (let symbol = 0; symbol < count; symbol++) lengthCount[lengths[symbol]]++;
  lengthCount[0] = 0;
  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + lengthCount[length - 1]) << 1;
    nextCode[length] = code;
  }
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    // Codes are defined most significant bit first and read least significant
    // bit first, so each one is reversed before it becomes an index.
    let canonical = nextCode[length]++;
    let reversed = 0;
    for (let bit = 0; bit < length; bit++) {
      reversed = (reversed << 1) | (canonical & 1);
      canonical >>= 1;
    }
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < table.length; index += 1 << length) table[index] = entry;
  }
  return { table, bits };
}

let inflateFixedTables = null;

function inflateFixed() {
  if (inflateFixedTables) return inflateFixedTables;
  const lengths = new Uint8Array(288);
  for (let symbol = 0; symbol < 288; symbol++) {
    lengths[symbol] = symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8;
  }
  const distances = new Uint8Array(30).fill(5);
  inflateFixedTables = { literal: inflateTable(lengths, 288), distance: inflateTable(distances, 30) };
  return inflateFixedTables;
}

// Returns a Uint8Array, or throws. A stream that ends early gives back what it
// held up to that point when `tolerant` is set: a truncated content stream
// still has most of a drawing in it, and most of a drawing is worth showing.
export function inflateBytes(input, start = 0, end = input.length, tolerant = true) {
  let pos = start;
  // The zlib header is two bytes whose value is a multiple of 31 and whose low
  // nibble says "deflate". Raw deflate has neither property except by chance.
  if (end - pos >= 2 && (input[pos] & 0x0f) === 8 && ((input[pos] << 8) | input[pos + 1]) % 31 === 0) {
    pos += (input[pos + 1] & 0x20) ? 6 : 2;
  }

  let out = new Uint8Array(Math.max(1024, (end - pos) * 4));
  let size = 0;
  let hold = 0;
  let held = 0;

  const grow = needed => {
    let capacity = out.length;
    while (capacity < needed) capacity *= 2;
    const bigger = new Uint8Array(capacity);
    bigger.set(out.subarray(0, size));
    out = bigger;
  };
  const fail = message => {
    if (tolerant && size) return out.subarray(0, size);
    throw new Error(message);
  };

  for (;;) {
    while (held < 3) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
    const last = hold & 1;
    const type = (hold >> 1) & 3;
    hold >>>= 3;
    held -= 3;

    if (type === 0) {
      // Stored: discard the rest of the current byte, then a length and its
      // complement. Whole bytes still sitting in the hold belong to the
      // length, so they are handed back before it is read.
      pos -= held >> 3;
      hold = 0;
      held = 0;
      if (pos + 4 > end) return fail('The compressed data ends inside a stored block.');
      const length = input[pos] | (input[pos + 1] << 8);
      pos += 4;
      const take = Math.min(length, Math.max(0, end - pos));
      if (size + take > out.length) grow(size + take);
      out.set(input.subarray ? input.subarray(pos, pos + take) : Array.prototype.slice.call(input, pos, pos + take), size);
      size += take;
      pos += length;
      if (take < length) return fail('The compressed data ends inside a stored block.');
    } else if (type === 1 || type === 2) {
      let literal;
      let distance;
      if (type === 1) {
        ({ literal, distance } = inflateFixed());
      } else {
        while (held < 14) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
        const literalCount = (hold & 31) + 257;
        const distanceCount = ((hold >> 5) & 31) + 1;
        const codeCount = ((hold >> 10) & 15) + 4;
        hold >>>= 14;
        held -= 14;
        const codeLengths = new Uint8Array(19);
        for (let index = 0; index < codeCount; index++) {
          while (held < 3) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
          codeLengths[INFLATE_CODE_LENGTH_ORDER[index]] = hold & 7;
          hold >>>= 3;
          held -= 3;
        }
        const codeTable = inflateTable(codeLengths, 19);
        const lengths = new Uint8Array(literalCount + distanceCount);
        let filled = 0;
        while (filled < lengths.length) {
          while (held < 16) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
          const entry = codeTable.table[hold & ((1 << codeTable.bits) - 1)];
          const used = entry & 15;
          if (!used) return fail('The compressed data has an invalid code length table.');
          hold >>>= used;
          held -= used;
          const symbol = entry >> 4;
          if (symbol < 16) { lengths[filled++] = symbol; continue; }
          let repeat;
          let value = 0;
          if (symbol === 16) {
            if (!filled) return fail('The compressed data repeats a length before giving one.');
            value = lengths[filled - 1];
            repeat = 3 + (hold & 3); hold >>>= 2; held -= 2;
          } else if (symbol === 17) {
            repeat = 3 + (hold & 7); hold >>>= 3; held -= 3;
          } else {
            repeat = 11 + (hold & 127); hold >>>= 7; held -= 7;
          }
          if (filled + repeat > lengths.length) return fail('The compressed data overruns its own code table.');
          while (repeat--) lengths[filled++] = value;
        }
        literal = inflateTable(lengths.subarray(0, literalCount), literalCount);
        distance = inflateTable(lengths.subarray(literalCount), distanceCount);
      }

      const literalMask = (1 << literal.bits) - 1;
      const distanceMask = (1 << distance.bits) - 1;
      for (;;) {
        if (pos > end + 8) return fail('The compressed data ends before its block does.');
        while (held < 15) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
        let entry = literal.table[hold & literalMask];
        let used = entry & 15;
        if (!used) return fail('The compressed data has an invalid literal code.');
        hold >>>= used;
        held -= used;
        let symbol = entry >> 4;
        if (symbol < 256) {
          if (size >= out.length) grow(size + 1);
          out[size++] = symbol;
          continue;
        }
        if (symbol === 256) break;
        symbol -= 257;
        if (symbol >= 29) return fail('The compressed data has an invalid length code.');
        let extra = INFLATE_LENGTH_EXTRA[symbol];
        while (held < extra) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
        const length = INFLATE_LENGTH_BASE[symbol] + (hold & ((1 << extra) - 1));
        hold >>>= extra;
        held -= extra;

        while (held < 15) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
        entry = distance.table[hold & distanceMask];
        used = entry & 15;
        if (!used) return fail('The compressed data has an invalid distance code.');
        hold >>>= used;
        held -= used;
        symbol = entry >> 4;
        if (symbol >= 30) return fail('The compressed data has an invalid distance code.');
        extra = INFLATE_DISTANCE_EXTRA[symbol];
        while (held < extra) { hold |= (pos < end ? input[pos] : 0) << held; pos++; held += 8; }
        const back = INFLATE_DISTANCE_BASE[symbol] + (hold & ((1 << extra) - 1));
        hold >>>= extra;
        held -= extra;
        if (back > size) return fail('The compressed data refers back past its own start.');

        if (size + length > out.length) grow(size + length);
        // Byte by byte on purpose: a match may overlap its own output, which
        // is how a run of one repeated byte is encoded.
        for (let index = 0; index < length; index++, size++) out[size] = out[size - back];
      }
    } else {
      return fail('The compressed data uses a block type that does not exist.');
    }
    if (last) break;
  }
  return out.subarray(0, size);
}
