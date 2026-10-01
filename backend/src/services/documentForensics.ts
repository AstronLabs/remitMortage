// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Identity document forgery detection via metadata analysis (issue #813).
 *
 * A document edited to alter text can look convincing to the eye while its
 * file still carries evidence of the edit. This module inspects the file's
 * own structure and metadata — no pixel decoding, no dependencies — and
 * reports every signal it finds so a reviewer knows what to look at.
 *
 * Signals (JPEG / PNG / PDF, detected from magic bytes, not the claimed MIME):
 *   editing_software_signature   an image/PDF editor named in Software/Creator/
 *                                Producer tags or XMP
 *   photoshop_resource_block     Adobe Photoshop's APP13 resource block
 *   edit_history_present         XMP edit history (stEvt / xmpMM:History)
 *   thumbnail_mismatch           embedded EXIF thumbnail's aspect ratio no
 *                                longer matches the image (stale thumbnail)
 *   dimension_mismatch           EXIF-recorded capture size != actual size
 *   multiple_jpeg_streams        a second JPEG concatenated after the first
 *   trailing_data_after_end      bytes appended after the image/PDF end marker
 *   modified_after_capture       EXIF/PDF modification date well after the
 *                                original capture/creation date
 *   pdf_incremental_update       PDF saved with appended revisions
 *   mime_type_mismatch           declared MIME type != actual file format
 *   no_exif_metadata / no_capture_device / standard_quantization_tables /
 *   no_pdf_metadata              informational (low severity) — legitimate
 *                                scans routinely look like this
 *
 * Policy: a document is flagged for MANUAL REVIEW — never auto-rejected — when
 * it has any `high` signal or at least `MEDIUM_SIGNALS_TO_FLAG` `medium`
 * signals. `low` signals are recorded for reviewer context but never flag on
 * their own, because a legitimate scan can easily lack rich metadata.
 *
 * Limits: this reads structure and tags, not pixels. A forger who strips or
 * rewrites all metadata evades it (the low-severity "no metadata" signals
 * exist to give reviewers that context); PDF Info dictionaries inside
 * compressed object streams are not inspected.
 */

import { inflateSync } from "zlib";

export type SignalSeverity = "high" | "medium" | "low";
export type DocumentFormat = "jpeg" | "png" | "pdf" | "unknown";

export interface ForensicSignal {
  code: string;
  severity: SignalSeverity;
  description: string;
  /** The concrete value that triggered the signal, for the reviewer. */
  evidence: string;
}

export interface ForensicAnalysis {
  format: DocumentFormat;
  flagged: boolean;
  signals: ForensicSignal[];
}

export const MEDIUM_SIGNALS_TO_FLAG = 2;
/** EXIF DateTime may trail DateTimeOriginal by this long before it counts as a later edit. */
export const MODIFIED_AFTER_CAPTURE_TOLERANCE_MS = 60_000;
/** Thumbnail/main aspect ratios may differ by this fraction before it counts as a mismatch. */
export const ASPECT_RATIO_TOLERANCE = 0.02;

const EDITING_SOFTWARE: Array<[RegExp, string]> = [
  [/photoshop/i, "Adobe Photoshop"],
  [/illustrator/i, "Adobe Illustrator"],
  [/\bgimp\b/i, "GIMP"],
  [/paint\.net/i, "Paint.NET"],
  [/pixelmator/i, "Pixelmator"],
  [/affinity/i, "Affinity"],
  [/\bcanva\b/i, "Canva"],
  [/photopea/i, "Photopea"],
  [/picsart/i, "PicsArt"],
  [/snapseed/i, "Snapseed"],
  [/\bfotor\b/i, "Fotor"],
  [/pixlr/i, "Pixlr"],
  [/inkscape/i, "Inkscape"],
  [/sejda/i, "Sejda PDF Editor"],
  [/pdfescape/i, "PDFescape"],
  [/pdf-?xchange/i, "PDF-XChange Editor"],
  [/foxit\s*phantom/i, "Foxit PhantomPDF"],
  [/nitro\s*(pro|pdf)/i, "Nitro PDF"],
];

function matchEditingSoftware(text: string): string | null {
  for (const [pattern, label] of EDITING_SOFTWARE) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectFormat(buf: Buffer): DocumentFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buf.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  return "unknown";
}

function mimeForFormat(format: DocumentFormat): string | null {
  return format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : format === "pdf" ? "application/pdf" : null;
}

// ---------------------------------------------------------------------------
// TIFF / EXIF
// ---------------------------------------------------------------------------

interface ExifData {
  make?: string;
  model?: string;
  software?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  pixelXDimension?: number;
  pixelYDimension?: number;
  thumbnail?: Buffer;
}

function parseTiff(tiff: Buffer): ExifData {
  const out: ExifData = {};
  if (tiff.length < 8) return out;
  const little = tiff.toString("latin1", 0, 2) === "II";
  if (!little && tiff.toString("latin1", 0, 2) !== "MM") return out;

  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const inBounds = (o: number, n: number) => o >= 0 && o + n <= tiff.length;

  interface Entry {
    tag: number;
    type: number;
    count: number;
    valueOffset: number;
  }

  function readIfd(offset: number): { entries: Entry[]; next: number } {
    if (!inBounds(offset, 2)) return { entries: [], next: 0 };
    const count = u16(offset);
    const entries: Entry[] = [];
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      if (!inBounds(at, 12)) break;
      const type = u16(at + 2);
      const n = u32(at + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4 } as Record<number, number>)[type] ?? 1;
      const inline = size * n <= 4;
      entries.push({ tag: u16(at), type, count: n, valueOffset: inline ? at + 8 : u32(at + 8) });
    }
    const nextAt = offset + 2 + count * 12;
    return { entries, next: inBounds(nextAt, 4) ? u32(nextAt) : 0 };
  }

  const ascii = (e: Entry): string | undefined => {
    if (e.type !== 2 || !inBounds(e.valueOffset, e.count)) return undefined;
    return tiff.toString("latin1", e.valueOffset, e.valueOffset + e.count).replace(/\0+$/, "").trim();
  };
  const num = (e: Entry): number | undefined => {
    if (!inBounds(e.valueOffset, e.type === 3 ? 2 : 4)) return undefined;
    if (e.type === 3) return u16(e.valueOffset);
    if (e.type === 4) return u32(e.valueOffset);
    return undefined;
  };

  const ifd0 = readIfd(u32(4));
  let exifPointer = 0;
  for (const e of ifd0.entries) {
    if (e.tag === 0x010f) out.make = ascii(e);
    else if (e.tag === 0x0110) out.model = ascii(e);
    else if (e.tag === 0x0131) out.software = ascii(e);
    else if (e.tag === 0x0132) out.dateTime = ascii(e);
    else if (e.tag === 0x8769) exifPointer = num(e) ?? 0;
  }

  if (exifPointer) {
    for (const e of readIfd(exifPointer).entries) {
      if (e.tag === 0x9003) out.dateTimeOriginal = ascii(e);
      else if (e.tag === 0xa002) out.pixelXDimension = num(e);
      else if (e.tag === 0xa003) out.pixelYDimension = num(e);
    }
  }

  if (ifd0.next) {
    let thumbOffset: number | undefined;
    let thumbLength: number | undefined;
    for (const e of readIfd(ifd0.next).entries) {
      if (e.tag === 0x0201) thumbOffset = num(e);
      else if (e.tag === 0x0202) thumbLength = num(e);
    }
    if (thumbOffset !== undefined && thumbLength !== undefined && inBounds(thumbOffset, thumbLength)) {
      out.thumbnail = tiff.subarray(thumbOffset, thumbOffset + thumbLength);
    }
  }
  return out;
}

/** "YYYY:MM:DD HH:MM:SS" -> epoch ms (both dates share a basis, so the offset cancels). */
function parseExifDate(value?: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value ?? "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// ---------------------------------------------------------------------------
// JPEG structure
// ---------------------------------------------------------------------------

interface JpegInfo {
  width?: number;
  height?: number;
  exif?: ExifData;
  xmp?: string;
  hasPhotoshopIrb: boolean;
  comments: string[];
  lumaQuantTable?: number[];
  trailing: Buffer;
}

function parseJpeg(buf: Buffer): JpegInfo {
  const info: JpegInfo = { hasPhotoshopIrb: false, comments: [], trailing: Buffer.alloc(0) };
  let off = 2;

  while (off + 1 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    if (marker === 0xd9) {
      info.trailing = buf.subarray(off + 2);
      return info;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      off += 2;
      continue;
    }
    if (off + 4 > buf.length) break;

    const length = buf.readUInt16BE(off + 2);
    const start = off + 4;
    const end = off + 2 + length;
    if (length < 2 || end > buf.length) break;
    const data = buf.subarray(start, end);

    if (marker === 0xe1 && data.toString("latin1", 0, 6) === "Exif\0\0") {
      info.exif = parseTiff(data.subarray(6));
    } else if (marker === 0xe1 && data.toString("latin1", 0, 29).startsWith("http://ns.adobe.com/xap/1.0/")) {
      info.xmp = data.toString("utf8", 29);
    } else if (marker === 0xed && data.toString("latin1", 0, 13) === "Photoshop 3.0") {
      info.hasPhotoshopIrb = true;
    } else if (marker === 0xfe) {
      info.comments.push(data.toString("latin1").trim());
    } else if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && data.length >= 5 && info.width === undefined) {
      info.height = data.readUInt16BE(1);
      info.width = data.readUInt16BE(3);
    } else if (marker === 0xdb && info.lumaQuantTable === undefined) {
      // First DQT table is luminance; only 8-bit precision tables are compared.
      if (data.length >= 65 && data[0] >> 4 === 0 && (data[0] & 0x0f) === 0) {
        info.lumaQuantTable = Array.from(data.subarray(1, 65));
      }
    }

    off = end;
    if (marker === 0xda) {
      // Entropy-coded data follows the SOS header until the next real marker.
      while (off + 1 < buf.length) {
        if (buf[off] === 0xff && buf[off + 1] !== 0x00 && !(buf[off + 1] >= 0xd0 && buf[off + 1] <= 0xd7) && buf[off + 1] !== 0xff) {
          break;
        }
        off += 1;
      }
    }
  }
  return info;
}

const IJG_LUMA_BASE_NATURAL = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80,
  62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98,
  112, 100, 103, 99,
];
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42,
  49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** The libjpeg (IJG) luminance table for a quality setting, in zigzag order (as stored in a DQT segment). */
export function ijgLumaTable(quality: number): number[] {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return ZIGZAG.map((natural) =>
    Math.min(255, Math.max(1, Math.floor((IJG_LUMA_BASE_NATURAL[natural] * scale + 50) / 100)))
  );
}

function matchIjgQuality(table: number[]): number | null {
  for (let q = 1; q <= 100; q++) {
    const candidate = ijgLumaTable(q);
    if (candidate.every((v, i) => v === table[i])) return q;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared signal builders
// ---------------------------------------------------------------------------

function editingSoftwareSignal(source: string, value: string): ForensicSignal | null {
  const label = matchEditingSoftware(value);
  if (!label) return null;
  return {
    code: "editing_software_signature",
    severity: "high",
    description: `${source} names editing software (${label}).`,
    evidence: `${source}: "${value.slice(0, 120)}"`,
  };
}

function xmpSignals(xmp: string | undefined): ForensicSignal[] {
  if (!xmp) return [];
  const signals: ForensicSignal[] = [];

  const creator = /<xmp:CreatorTool>([^<]+)<\/xmp:CreatorTool>|xmp:CreatorTool="([^"]+)"/.exec(xmp);
  const creatorValue = creator?.[1] ?? creator?.[2];
  if (creatorValue) {
    const s = editingSoftwareSignal("XMP CreatorTool", creatorValue);
    if (s) signals.push(s);
  }

  if (/stEvt:action|xmpMM:History/.test(xmp)) {
    const actions = Array.from(xmp.matchAll(/stEvt:action(?:="|>)([^"<]+)/g)).map((m) => m[1]);
    const agents = Array.from(xmp.matchAll(/stEvt:softwareAgent(?:="|>)([^"<]+)/g)).map((m) => m[1]);
    signals.push({
      code: "edit_history_present",
      severity: "high",
      description: "XMP metadata contains an edit history — the file was saved after editing.",
      evidence:
        `actions: ${actions.join(", ") || "n/a"}` + (agents.length ? `; software: ${[...new Set(agents)].join(", ")}` : ""),
    });
    for (const agent of new Set(agents)) {
      const s = editingSoftwareSignal("XMP edit-history softwareAgent", agent);
      if (s && !signals.some((x) => x.code === s.code && x.evidence === s.evidence)) signals.push(s);
    }
  }
  return signals;
}

function modifiedAfterCaptureSignal(original?: string, modified?: string): ForensicSignal | null {
  const o = parseExifDate(original);
  const m = parseExifDate(modified);
  if (o === null || m === null || m - o <= MODIFIED_AFTER_CAPTURE_TOLERANCE_MS) return null;
  const hours = (m - o) / 3_600_000;
  return {
    code: "modified_after_capture",
    severity: "medium",
    description: "The file's modification date is later than its original capture date.",
    evidence: `captured ${original}, modified ${modified} (${hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`} later)`,
  };
}

function isBlankTail(tail: Buffer): boolean {
  return tail.every((b) => b === 0x00 || b === 0x0a || b === 0x0d || b === 0x20);
}

// ---------------------------------------------------------------------------
// Per-format analysis
// ---------------------------------------------------------------------------

function analyzeJpeg(buf: Buffer): ForensicSignal[] {
  const signals: ForensicSignal[] = [];
  let info: JpegInfo;
  try {
    info = parseJpeg(buf);
  } catch {
    return signals;
  }
  const exif = info.exif;

  if (exif?.software) {
    const s = editingSoftwareSignal("EXIF Software tag", exif.software);
    if (s) signals.push(s);
  }
  signals.push(...xmpSignals(info.xmp));
  for (const comment of info.comments) {
    const s = editingSoftwareSignal("JPEG comment", comment);
    if (s) signals.push(s);
  }

  if (info.hasPhotoshopIrb) {
    signals.push({
      code: "photoshop_resource_block",
      severity: "high",
      description: "File contains Adobe Photoshop's image resource block (APP13), written when saved from Photoshop.",
      evidence: 'APP13 segment "Photoshop 3.0"',
    });
  }

  if (exif?.thumbnail) {
    try {
      const thumb = parseJpeg(exif.thumbnail);
      if (thumb.width && thumb.height && info.width && info.height) {
        const thumbRatio = thumb.width / thumb.height;
        const mainRatio = info.width / info.height;
        if (Math.abs(thumbRatio - mainRatio) / mainRatio > ASPECT_RATIO_TOLERANCE) {
          signals.push({
            code: "thumbnail_mismatch",
            severity: "high",
            description:
              "The embedded EXIF thumbnail no longer matches the image — typical of an image cropped or edited after capture by software that did not refresh the thumbnail.",
            evidence: `thumbnail ${thumb.width}x${thumb.height} (ratio ${thumbRatio.toFixed(3)}) vs image ${info.width}x${info.height} (ratio ${mainRatio.toFixed(3)})`,
          });
        }
      }
    } catch {
      // A corrupt thumbnail is not itself evidence.
    }
  }

  if (exif && exif.pixelXDimension && exif.pixelYDimension && info.width && info.height) {
    if (exif.pixelXDimension !== info.width || exif.pixelYDimension !== info.height) {
      signals.push({
        code: "dimension_mismatch",
        severity: "medium",
        description: "The capture size recorded in EXIF differs from the image's actual size — it was resized or re-saved after capture.",
        evidence: `EXIF ${exif.pixelXDimension}x${exif.pixelYDimension} vs actual ${info.width}x${info.height}`,
      });
    }
  }

  const modified = modifiedAfterCaptureSignal(exif?.dateTimeOriginal, exif?.dateTime);
  if (modified) signals.push(modified);

  if (info.trailing.length > 0 && !isBlankTail(info.trailing)) {
    if (info.trailing[0] === 0xff && info.trailing[1] === 0xd8) {
      signals.push({
        code: "multiple_jpeg_streams",
        severity: "high",
        description: "A second JPEG stream is concatenated after the first — inconsistent with a single capture.",
        evidence: `${info.trailing.length} bytes of additional JPEG data after the end-of-image marker`,
      });
    } else {
      signals.push({
        code: "trailing_data_after_end",
        severity: "medium",
        description: "Data is appended after the JPEG end-of-image marker. (Some phones append motion-photo data; a reviewer should confirm.)",
        evidence: `${info.trailing.length} trailing bytes`,
      });
    }
  }

  // Informational context for reviewers — never flags on its own.
  if (!exif) {
    signals.push({
      code: "no_exif_metadata",
      severity: "low",
      description: "No EXIF metadata. Common for scans and messaging-app re-shares, but also what stripping metadata looks like.",
      evidence: "no APP1 Exif segment",
    });
  } else if (!exif.make && !exif.model) {
    signals.push({
      code: "no_capture_device",
      severity: "low",
      description: "EXIF is present but records no camera/scanner make or model.",
      evidence: exif.software ? `Software: "${exif.software}"` : "no Make/Model tags",
    });
  }
  if (info.lumaQuantTable) {
    const q = matchIjgQuality(info.lumaQuantTable);
    if (q !== null) {
      signals.push({
        code: "standard_quantization_tables",
        severity: "low",
        description: "Quantization tables exactly match the standard libjpeg table — the image was encoded by software (also true of many legitimate apps and scanners).",
        evidence: `luminance table matches IJG quality ${q}`,
      });
    }
  }
  return signals;
}

function analyzePng(buf: Buffer): ForensicSignal[] {
  const signals: ForensicSignal[] = [];
  let off = 8;
  let exif: ExifData | undefined;
  const xmpBlocks: string[] = [];
  let trailing = Buffer.alloc(0);

  while (off + 12 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    const end = start + length;
    if (end + 4 > buf.length) break;
    const data = buf.subarray(start, end);

    try {
      if (type === "tEXt") {
        const sep = data.indexOf(0);
        const keyword = data.toString("latin1", 0, sep);
        const text = data.toString("latin1", sep + 1);
        if (/^(software|creator|comment|description)$/i.test(keyword)) {
          const s = editingSoftwareSignal(`PNG ${keyword} text`, text);
          if (s) signals.push(s);
        }
      } else if (type === "iTXt") {
        const sep = data.indexOf(0);
        const keyword = data.toString("latin1", 0, sep);
        const compressed = data[sep + 1] === 1;
        let cursor = sep + 3; // skip compression flag + method
        cursor = data.indexOf(0, cursor) + 1; // language tag
        cursor = data.indexOf(0, cursor) + 1; // translated keyword
        const raw = data.subarray(cursor);
        const text = (compressed ? inflateSync(raw) : raw).toString("utf8");
        if (keyword === "XML:com.adobe.xmp") xmpBlocks.push(text);
        else if (/^(software|creator|comment)$/i.test(keyword)) {
          const s = editingSoftwareSignal(`PNG ${keyword} text`, text);
          if (s) signals.push(s);
        }
      } else if (type === "zTXt") {
        const sep = data.indexOf(0);
        const keyword = data.toString("latin1", 0, sep);
        const text = inflateSync(data.subarray(sep + 2)).toString("latin1");
        if (/^(software|creator|comment)$/i.test(keyword)) {
          const s = editingSoftwareSignal(`PNG ${keyword} text`, text);
          if (s) signals.push(s);
        }
      } else if (type === "eXIf") {
        exif = parseTiff(data);
      }
    } catch {
      // A malformed ancillary chunk is not evidence of tampering.
    }

    off = end + 4;
    if (type === "IEND") {
      trailing = buf.subarray(off);
      break;
    }
  }

  if (exif?.software) {
    const s = editingSoftwareSignal("EXIF Software tag", exif.software);
    if (s) signals.push(s);
  }
  for (const xmp of xmpBlocks) signals.push(...xmpSignals(xmp));
  const modified = modifiedAfterCaptureSignal(exif?.dateTimeOriginal, exif?.dateTime);
  if (modified) signals.push(modified);

  if (trailing.length > 0 && !isBlankTail(trailing)) {
    signals.push({
      code: "trailing_data_after_end",
      severity: "medium",
      description: "Data is appended after the PNG IEND chunk.",
      evidence: `${trailing.length} trailing bytes`,
    });
  }
  return signals;
}

function parsePdfDate(value: string | undefined): number | null {
  const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(value ?? "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function pdfString(text: string, key: string): string | undefined {
  const m = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(text);
  return m?.[1];
}

function analyzePdf(buf: Buffer): ForensicSignal[] {
  const signals: ForensicSignal[] = [];
  const text = buf.toString("latin1");

  const producer = pdfString(text, "Producer");
  const creator = pdfString(text, "Creator");
  for (const [label, value] of [
    ["PDF Producer", producer],
    ["PDF Creator", creator],
  ] as const) {
    if (value) {
      const s = editingSoftwareSignal(label, value);
      if (s) signals.push(s);
    }
  }

  const xmp = /<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/.exec(text)?.[0];
  if (xmp) {
    const pdfProducer = /<pdf:Producer>([^<]+)<\/pdf:Producer>/.exec(xmp)?.[1];
    if (pdfProducer) {
      const s = editingSoftwareSignal("XMP pdf:Producer", pdfProducer);
      if (s && !signals.some((x) => x.evidence.includes(pdfProducer))) signals.push(s);
    }
    signals.push(...xmpSignals(xmp));
  }

  const eofCount = (text.match(/%%EOF/g) ?? []).length;
  if (eofCount > 1) {
    signals.push({
      code: "pdf_incremental_update",
      severity: "medium",
      description:
        "The PDF was saved with appended revisions (multiple %%EOF markers). Also normal for signed or filled-in forms; a reviewer should compare revisions.",
      evidence: `${eofCount} %%EOF markers`,
    });
  }

  const created = parsePdfDate(pdfString(text, "CreationDate"));
  const modified = parsePdfDate(pdfString(text, "ModDate"));
  if (created !== null && modified !== null && modified - created > 86_400_000) {
    signals.push({
      code: "modified_after_capture",
      severity: "medium",
      description: "The PDF's modification date is more than a day after its creation date.",
      evidence: `created ${pdfString(text, "CreationDate")}, modified ${pdfString(text, "ModDate")}`,
    });
  }

  if (!producer && !creator && !xmp) {
    signals.push({
      code: "no_pdf_metadata",
      severity: "low",
      description: "The PDF has no Producer, Creator or XMP metadata (or it is stored in a compressed object stream this check does not read).",
      evidence: "no /Producer, /Creator or XMP packet found",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function evaluateFlagPolicy(signals: readonly ForensicSignal[]): boolean {
  return (
    signals.some((s) => s.severity === "high") ||
    signals.filter((s) => s.severity === "medium").length >= MEDIUM_SIGNALS_TO_FLAG
  );
}

export function analyzeDocumentMetadata(buffer: Buffer, declaredMimeType?: string): ForensicAnalysis {
  const format = detectFormat(buffer);
  const signals: ForensicSignal[] = [];

  const actualMime = mimeForFormat(format);
  if (declaredMimeType && actualMime && declaredMimeType !== actualMime) {
    signals.push({
      code: "mime_type_mismatch",
      severity: "medium",
      description: "The file's actual format differs from the type it was uploaded as.",
      evidence: `declared ${declaredMimeType}, actual ${actualMime}`,
    });
  }

  if (format === "jpeg") signals.push(...analyzeJpeg(buffer));
  else if (format === "png") signals.push(...analyzePng(buffer));
  else if (format === "pdf") signals.push(...analyzePdf(buffer));

  return { format, flagged: evaluateFlagPolicy(signals), signals };
}
