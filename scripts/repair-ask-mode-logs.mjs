/**
 * Repair session logs written by `dsh-helper-plugin-command-ask` 0.1.x.
 *
 * The first release persisted ask-mode state as its own session event type,
 * `ask/mode`. A plugin outside the harness repository cannot add to the
 * harness's event vocabulary: `Session.append()` cannot set the envelope's
 * `ignorable` marker, and the persistence read path refuses any unknown type
 * that lacks it —
 *
 *   session "…" contains event type "ask/mode" (seq 5) unknown to this harness
 *   and not marked ignorable; refusing to interpret the log
 *
 * — which makes the whole session unloadable. Later plugin versions derive the
 * mode from events the harness already knows (`command/run`, `command/done`,
 * `turn/end`) and write no vocabulary of their own.
 *
 * The repair adds the missing `ignorable: true` to those records. Dropping them
 * instead would be wrong: the stored log must stay seq-dense ("format v2 event N
 * is not dense", "not contiguous; expected N"), so a record can be marked opaque
 * but not removed. A marked record is retained as opaque metadata, changes no
 * surface, and no longer blocks the read.
 *
 * Usage (dry run first — nothing is written without `--apply`):
 *
 *   node scripts/repair-ask-mode-logs.mjs --sessions <DSH_HOME>/sessions
 *   node scripts/repair-ask-mode-logs.mjs --sessions <DSH_HOME>/sessions --apply --backup <dir>
 *
 * The artifact is a concatenated-frame Zstandard container, so it is decoded
 * frame by frame (the same scanner the JSONL provider uses) and rewritten as one
 * frame with the provider's checksum option. Every rewritten log is copied under
 * `--backup` first, so the original bytes remain recoverable.
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/** The stray event type this repair marks ignorable. */
const LEGACY_TYPE = 'ask/mode';
const ZSTD_MAGIC = 4247762216;
/** The provider writes frames with a content checksum. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** Parse `--flag value` / `--flag`. */
function parseArgs(argv) {
  const options = { apply: false, backup: undefined, sessions: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      options.apply = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

/**
 * Locate complete frames in the concatenated-frame container. Ported from the
 * JSONL provider's `scanZstdFrames`: frame boundaries cannot be found by
 * decompressing, because a zstd stream decode stops at the first frame.
 *
 * @param {Buffer} buffer - the artifact bytes.
 * @returns {{ frames: {start: number, end: number}[], tornStart?: number }} the ranges.
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Decode every complete frame and join the text; a torn tail is repaired away. */
function decodeArtifact(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error('no complete frame');
  const parts = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
  return { text: parts.join(''), frames: parts.length, tornStart };
}

/**
 * Re-encode a repaired log as a concatenated-frame container.
 *
 * The reader requires the first frame to hold exactly the header line
 * (`assertIndependentHeaderFrame`), so the header stays its own frame and the
 * remaining records follow in one frame. A single trailing frame is a valid
 * container: the physical framing exists so a torn append can be recovered, not
 * to carry meaning per batch.
 *
 * @param {string[]} lines - the complete record lines, without newlines.
 * @returns {Buffer} the artifact bytes.
 */
function encodeArtifact(lines) {
  const header = Buffer.from(`${lines[0]}\n`, 'utf8');
  const rest = lines.length > 1 ? Buffer.from(`${lines.slice(1).join('\n')}\n`, 'utf8') : undefined;
  const frames = [zstdCompressSync(header, CHECKSUM_OPTIONS)];
  if (rest !== undefined) frames.push(zstdCompressSync(rest, CHECKSUM_OPTIONS));
  return Buffer.concat(frames);
}

/** Every session artifact under the root. */
async function collect(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, found);
    else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

const options = parseArgs(process.argv.slice(2));
if (options.sessions === undefined) throw new Error('pass --sessions <DSH_HOME>/sessions');
const root = resolve(options.sessions);

let scanned = 0;
let repaired = 0;
let marked = 0;
let torn = 0;

for (const path of (await collect(root)).sort()) {
  scanned += 1;
  const relativePath = relative(root, path);
  const original = await readFile(path);
  let decoded;
  try {
    decoded = path.endsWith('.zstd') ? decodeArtifact(original) : { text: original.toString('utf8'), tornStart: undefined };
  } catch (error) {
    process.stdout.write(`?  ${relativePath}: cannot decode (${error instanceof Error ? error.message : String(error)})\n`);
    continue;
  }
  if (decoded.tornStart !== undefined) torn += 1;

  const lines = decoded.text.split('\n').filter((line) => line.trim() !== '');
  let changes = 0;
  const next = lines.map((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (record?.type !== LEGACY_TYPE || record.ignorable === true) return line;
    changes += 1;
    const { type, seq, time, data, ...rest } = record;
    return JSON.stringify({ type, seq, time, data, ...rest, ignorable: true });
  });

  if (changes === 0) {
    process.stdout.write(`ok ${relativePath}\n`);
    continue;
  }
  marked += changes;
  process.stdout.write(`${options.apply ? '->' : 'DRY'} ${relativePath}: mark ${changes} ${LEGACY_TYPE} record(s) ignorable\n`);
  if (!options.apply) continue;

  if (options.backup !== undefined) {
    const target = join(resolve(options.backup), relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
  }
  await writeFile(path, path.endsWith('.zstd') ? encodeArtifact(next) : Buffer.from(`${next.join('\n')}\n`, 'utf8'));
  repaired += 1;
}

process.stdout.write(`\nscanned ${scanned} artifact(s); ${marked} record(s) in ${repaired} file(s) rewritten`);
if (torn > 0) process.stdout.write(`; ${torn} had an incomplete final frame (repaired by the rewrite)`);
process.stdout.write('\n');
if (!options.apply && marked > 0) process.stdout.write('dry run: re-run with --apply to rewrite the logs\n');
