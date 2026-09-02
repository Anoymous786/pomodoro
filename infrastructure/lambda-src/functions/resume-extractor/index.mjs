/**
 * resume-extractor  (Phase 3, S3 event-triggered — no API route)
 *
 * s3:ObjectCreated on uploads/* -> extract text -> write extracted/<key>.json.
 * Supported: .txt/.md/.markdown/.csv (native), .pdf and .docx via a small
 * built-in zlib reader — this function has ZERO npm dependencies, like every
 * other function in the stack.
 *
 * Failure philosophy: a corrupt file should NEVER loop through retries — S3
 * would just re-invoke us on the same object. Per-record failures are written
 * to extracted/<key>.json as {error}, letting the frontend poll surface an
 * honest message instead of spinning forever.
 */
import zlib from "node:zlib";
import { GetObjectCommand, PutObjectCommand, s3 } from "./aws.mjs";

const MAX_TEXT_CHARS = 8000; // matches the intake pipeline's cap

// ------------------------------------------------------------------
// Shared ZIP machinery (used by .docx): locate End-Of-Central-Directory,
// walk central-directory entries, inflateRaw the wanted member.
// ------------------------------------------------------------------
function readZipEntry(buf, wantedName) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no EOCD).");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name !== wantedName) continue;

    // Local file header: skip its name+extra to reach the data.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Corrupt local header.");
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) return data; // stored
    if (method === 8) return zlib.inflateRawSync(data); // deflated
    throw new Error(`Unsupported compression method ${method}.`);
  }
  return null;
}

function extractDocxText(buf) {
  const xmlBuf = readZipEntry(buf, "word/document.xml");
  if (!xmlBuf) throw new Error("word/document.xml not found in the .docx.");
  return xmlBuf
    .toString("utf8")
    .replace(/<w:p[ >]/g, "\n<w:p ") // paragraph breaks
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "") // strip all tags
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// ------------------------------------------------------------------
// PDF: decode Flate streams, then pull literal strings out of the text-
// showing operators (Tj / TJ). Best-effort by design — same contract as
// the client-side extractor it replaces: text-based PDFs work, scanned/
// image-only PDFs fail with an honest error message.
// ------------------------------------------------------------------
function extractPdfText(bytes) {
  const raw = Buffer.from(bytes).toString("latin1");

  // Collect every stream...endstream body we can inflate.
  let decoded = "";
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], "latin1");
    for (const attempt of [
      () => zlib.inflateSync(chunk),
      () => zlib.inflateRawSync(chunk),
      () => chunk,
    ]) {
      try {
        decoded += attempt().toString("latin1") + "\n";
        break;
      } catch {
        /* try next strategy */
      }
    }
  }
  const source = decoded.length > 32 ? decoded : raw;

  const pieces = [];
  // (text) Tj   and   [(a) -2 (b)] TJ
  const tjRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ)/g;
  const arrRe = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  let match;

  const unescape = (s) =>
    s.replace(/\\([()\\])/g, "$1").replace(/\\[rn]/g, " ");

  while ((match = arrRe.exec(source)) !== null) {
    for (const inner of match[1].matchAll(tjRe)) pieces.push(unescape(inner[1]));
  }
  while ((match = tjRe.exec(source)) !== null) {
    pieces.push(unescape(match[1]));
  }

  const text = pieces
    .filter((s) => /[A-Za-z]{2,}/.test(s))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.replace(/\s+/g, "").length < 40) {
    throw new Error("No extractable text layer found in this PDF.");
  }
  return text;
}

async function extractText(ext, bytes) {
  switch (ext) {
    case "txt":
    case "md":
    case "markdown":
    case "csv":
      return Buffer.from(bytes).toString("utf8");
    case "pdf":
      return extractPdfText(bytes);
    case "docx":
      return extractDocxText(Buffer.from(bytes));
    default:
      // Last resort, mirrors the client-side behavior it replaces.
      return Buffer.from(bytes).toString("utf8");
  }
}

export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    // S3 URL-encodes keys with '+' for spaces.
    const key = decodeURIComponent(
      record.s3.object.key.replace(/\+/g, " ")
    );
    const bucket = record.s3.bucket.name;
    const ext = (key.split(".").pop() ?? "").toLowerCase();

    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body.transformToByteArray();

      let text = await extractText(ext, bytes);
      let truncated = false;
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `extracted/${key}.json`,
          ContentType: "application/json",
          Body: JSON.stringify({
            key,
            text,
            chars: text.length,
            truncated,
            extractedAt: Date.now(),
          }),
        })
      );
      console.log(`Extracted ${text.length} chars from ${key} (${ext}).`);
    } catch (err) {
      console.error(`Extraction failed for ${key}:`, err);
      // Write the failure so pollers get closure instead of infinite pending.
      await s3
        .send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `extracted/${key}.json`,
            ContentType: "application/json",
            Body: JSON.stringify({
              key,
              text: null,
              error:
                "We couldn't read text from this file (it may be scanned images or password-protected). Try a .txt export.",
              failedAt: Date.now(),
            }),
          })
        )
        .catch((e) => console.error("Failed to record extraction error:", e));
    }
  }
};