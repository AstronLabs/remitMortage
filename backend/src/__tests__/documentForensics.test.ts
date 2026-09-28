// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for identity document forgery detection via metadata analysis
 * (issue #813), using synthetic-but-structurally-valid fixtures: a clean
 * single-capture camera JPEG, a legitimate metadata-less scan, and a range
 * of tampered documents.
 *
 * Acceptance criteria under test:
 * 1. A document with editing-software metadata signatures or
 *    tampering-consistent compression artifacts is flagged for manual review.
 * 2. The flag includes the specific signal that triggered it.
 */

import { deflateSync } from "zlib";
import {
  MEDIUM_SIGNALS_TO_FLAG,
  analyzeDocumentMetadata,
  detectFormat,
  evaluateFlagPolicy,
  ijgLumaTable,
} from "../services/documentForensics.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface TiffOptions {
  make?: string;
  model?: string;
  software?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  pixelX?: number;
  pixelY?: number;
  thumbnail?: Buffer;
}

type Val = { tag: number; type: 2 | 4; value: string | number };

/** Minimal little-endian TIFF/EXIF block. */
function buildTiff(o: TiffOptions): Buffer {
  const ifd0: Val[] = [];
  if (o.make) ifd0.push({ tag: 0x010f, type: 2, value: o.make });
  if (o.model) ifd0.push({ tag: 0x0110, type: 2, value: o.model });
  if (o.software) ifd0.push({ tag: 0x0131, type: 2, value: o.software });
  if (o.dateTime) ifd0.push({ tag: 0x0132, type: 2, value: o.dateTime });

  const exif: Val[] = [];
  if (o.dateTimeOriginal) exif.push({ tag: 0x9003, type: 2, value: o.dateTimeOriginal });
  if (o.pixelX) exif.push({ tag: 0xa002, type: 4, value: o.pixelX });
  if (o.pixelY) exif.push({ tag: 0xa003, type: 4, value: o.pixelY });
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, value: 0 });

  const ifd1: Val[] = o.thumbnail
    ? [
        { tag: 0x0201, type: 4, value: 0 },
        { tag: 0x0202, type: 4, value: o.thumbnail.length },
      ]
    : [];

  const size = (n: number) => 2 + n * 12 + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + size(ifd0.length);
  const ifd1Off = exifOff + (exif.length ? size(exif.length) : 0);
  const dataStart = ifd1Off + (ifd1.length ? size(ifd1.length) : 0);

  const chunks: Buffer[] = [];
  let dataLen = 0;
  const alloc = (b: Buffer) => {
    const off = dataStart + dataLen;
    chunks.push(b);
    dataLen += b.length;
    return off;
  };

  const pointer = ifd0.find((e) => e.tag === 0x8769);
  if (pointer) pointer.value = exifOff;
  if (o.thumbnail) ifd1[0].value = alloc(o.thumbnail);

  const write = (entries: Val[], next: number): Buffer => {
    const out = Buffer.alloc(size(entries.length));
    out.writeUInt16LE(entries.length, 0);
    entries.forEach((e, i) => {
      const at = 2 + i * 12;
      out.writeUInt16LE(e.tag, at);
      out.writeUInt16LE(e.type, at + 2);
      if (e.type === 2) {
        const bytes = Buffer.from(`${e.value}\0`, "latin1");
        out.writeUInt32LE(bytes.length, at + 4);
        if (bytes.length <= 4) bytes.copy(out, at + 8);
        else out.writeUInt32LE(alloc(bytes), at + 8);
      } else {
        out.writeUInt32LE(1, at + 4);
        out.writeUInt32LE(e.value as number, at + 8);
      }
    });
    out.writeUInt32LE(next, 2 + entries.length * 12);
    return out;
  };

  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  return Buffer.concat([
    header,
    write(ifd0, ifd1.length ? ifd1Off : 0),
    exif.length ? write(exif, 0) : Buffer.alloc(0),
    ifd1.length ? write(ifd1, 0) : Buffer.alloc(0),
    ...chunks,
  ]);
}

function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

interface JpegOptions extends TiffOptions {
  width?: number;
  height?: number;
  hasExif?: boolean;
  xmp?: string;
  photoshopIrb?: boolean;
  comment?: string;
  lumaTable?: number[];
  trailing?: Buffer;
}

/** Structurally valid JPEG: SOI, optional metadata segments, DQT, SOF0, SOS + scan data, EOI, trailing. */
function buildJpeg(o: JpegOptions = {}): Buffer {
  const width = o.width ?? 4000;
  const height = o.height ?? 3000;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (o.hasExif ?? true) {
    parts.push(segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), buildTiff(o)])));
  }
  if (o.xmp) {
    parts.push(segment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(o.xmp, "utf8")])));
  }
  if (o.photoshopIrb) {
    parts.push(segment(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), Buffer.from("8BIM", "latin1")])));
  }
  if (o.comment) parts.push(segment(0xfe, Buffer.from(o.comment, "latin1")));

  // Vendor-style table: not derivable from any libjpeg quality setting.
  const table = o.lumaTable ?? Array.from({ length: 64 }, () => 3);
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.from(table)])));

  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  parts.push(segment(0xc0, sof));

  parts.push(segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])));
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78])); // entropy data incl. a stuffed 0xFF
  parts.push(Buffer.from([0xff, 0xd9]));
  if (o.trailing) parts.push(o.trailing);
  return Buffer.concat(parts);
}

const CAPTURE = "2026:03:01 10:15:30";

/** A clean single-capture phone/camera photo: nothing to flag. */
function cleanCameraJpeg(overrides: JpegOptions = {}): Buffer {
  return buildJpeg({
    make: "Canon",
    model: "EOS 80D",
    dateTime: CAPTURE,
    dateTimeOriginal: CAPTURE,
    pixelX: 4000,
    pixelY: 3000,
    thumbnail: buildJpeg({ hasExif: false, width: 160, height: 120 }),
    ...overrides,
  });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not verified by the analyzer
}

function buildPng(o: { software?: string; xmp?: string; compressedSoftware?: string; trailing?: Buffer } = {}): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  chunks.push(pngChunk("IHDR", Buffer.alloc(13)));
  if (o.software) chunks.push(pngChunk("tEXt", Buffer.from(`Software\0${o.software}`, "latin1")));
  if (o.compressedSoftware) {
    chunks.push(pngChunk("zTXt", Buffer.concat([Buffer.from("Software\0\0", "latin1"), deflateSync(Buffer.from(o.compressedSoftware))])));
  }
  if (o.xmp) {
    chunks.push(pngChunk("iTXt", Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(o.xmp, "utf8")])));
  }
  chunks.push(pngChunk("IDAT", Buffer.from([1, 2, 3])));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  if (o.trailing) chunks.push(o.trailing);
  return Buffer.concat(chunks);
}

function buildPdf(o: { producer?: string; creator?: string; creationDate?: string; modDate?: string; revisions?: number } = {}): Buffer {
  const info = [
    o.producer ? `/Producer (${o.producer})` : "",
    o.creator ? `/Creator (${o.creator})` : "",
    o.creationDate ? `/CreationDate (${o.creationDate})` : "",
    o.modDate ? `/ModDate (${o.modDate})` : "",
  ].join(" ");
  let body = `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << ${info} >> endobj\ntrailer << /Info 2 0 R >>\n%%EOF\n`;
  for (let i = 1; i < (o.revisions ?? 1); i++) body += `3 0 obj << /Updated ${i} >> endobj\ntrailer << /Prev 0 >>\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const PHOTOSHOP_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Adobe Photoshop 25.1 (Windows)"><xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved" stEvt:softwareAgent="Adobe Photoshop 25.1 (Windows)"/><rdf:li stEvt:action="converted"/></rdf:Seq></xmpMM:History></rdf:Description></rdf:RDF></x:xmpmeta>`;

function codes(buf: Buffer, mime = "image/jpeg") {
  return analyzeDocumentMetadata(buf, mime).signals.map((s) => s.code);
}

// ---------------------------------------------------------------------------
// Clean documents
// ---------------------------------------------------------------------------

describe("clean documents are not flagged", () => {
  it("passes a single-capture camera JPEG with no signals at all", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg(), "image/jpeg");
    expect(result.format).toBe("jpeg");
    expect(result.signals).toEqual([]);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a legitimate metadata-less scan, but records why it is thin", () => {
    const scan = buildJpeg({ hasExif: false });
    const result = analyzeDocumentMetadata(scan, "image/jpeg");
    expect(result.flagged).toBe(false);
    expect(result.signals.map((s) => s.code)).toEqual(["no_exif_metadata"]);
    expect(result.signals[0].severity).toBe("low");
  });

  it("does not flag a plain PNG or a plain PDF", () => {
    expect(analyzeDocumentMetadata(buildPng(), "image/png").flagged).toBe(false);
    expect(
      analyzeDocumentMetadata(buildPdf({ producer: "Microsoft Print To PDF", creationDate: "D:20260301101530" }), "application/pdf")
        .flagged
    ).toBe(false);
  });

  it("tolerates a trivially later EXIF modification time and blank trailing padding", () => {
    const jpeg = cleanCameraJpeg({ dateTime: "2026:03:01 10:15:50", trailing: Buffer.from([0, 0, 0, 0x0a]) });
    expect(analyzeDocumentMetadata(jpeg, "image/jpeg").signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Editing-software signatures (criterion 1)
// ---------------------------------------------------------------------------

describe("editing-software signatures flag the document with the specific signal", () => {
  it("flags Photoshop in the EXIF Software tag, naming the tool and the tag", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ software: "Adobe Photoshop 25.1 (Windows)" }), "image/jpeg");
    expect(result.flagged).toBe(true);
    const signal = result.signals.find((s) => s.code === "editing_software_signature");
    expect(signal).toMatchObject({ severity: "high" });
    expect(signal!.description).toContain("Adobe Photoshop");
    expect(signal!.evidence).toContain("EXIF Software tag");
    expect(signal!.evidence).toContain("Adobe Photoshop 25.1 (Windows)");
  });

  it("flags the Photoshop APP13 resource block", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ photoshopIrb: true }), "image/jpeg");
    expect(result.flagged).toBe(true);
    expect(result.signals.map((s) => s.code)).toContain("photoshop_resource_block");
  });

  it("flags XMP edit history and reports the recorded actions and software", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ xmp: PHOTOSHOP_XMP }), "image/jpeg");
    expect(result.flagged).toBe(true);
    const history = result.signals.find((s) => s.code === "edit_history_present");
    expect(history!.evidence).toContain("saved");
    expect(history!.evidence).toContain("converted");
    expect(history!.evidence).toContain("Adobe Photoshop 25.1 (Windows)");
    expect(result.signals.map((s) => s.code)).toContain("editing_software_signature");
  });

  it.each([
    ["GIMP 2.10.34", "GIMP"],
    ["Paint.NET v5.0", "Paint.NET"],
    ["Pixelmator Pro 3.5", "Pixelmator"],
    ["Snapseed 2.0", "Snapseed"],
  ])("recognizes %s", (software, label) => {
    const signal = analyzeDocumentMetadata(cleanCameraJpeg({ software }), "image/jpeg").signals.find(
      (s) => s.code === "editing_software_signature"
    );
    expect(signal?.description).toContain(label);
  });

  it("does not treat ordinary camera firmware or OS versions as editing software", () => {
    for (const software of ["Ver.1.0.1", "17.4.1", "Samsung Camera 9.0"]) {
      expect(codes(cleanCameraJpeg({ software }))).not.toContain("editing_software_signature");
    }
  });

  it("flags editing software named in a JPEG comment", () => {
    expect(codes(cleanCameraJpeg({ comment: "Edited with GIMP" }))).toContain("editing_software_signature");
  });

  it("flags editing software in PNG text chunks, including compressed ones, and PNG XMP history", () => {
    expect(analyzeDocumentMetadata(buildPng({ software: "Adobe Photoshop 24.0" }), "image/png").flagged).toBe(true);
    expect(analyzeDocumentMetadata(buildPng({ compressedSoftware: "GIMP 2.10" }), "image/png").flagged).toBe(true);
    expect(codes(buildPng({ xmp: PHOTOSHOP_XMP }), "image/png")).toContain("edit_history_present");
  });

  it("flags PDF editors in Producer/Creator", () => {
    const result = analyzeDocumentMetadata(buildPdf({ producer: "Sejda PDF Editor 5.0" }), "application/pdf");
    expect(result.flagged).toBe(true);
    expect(result.signals[0].evidence).toContain("PDF Producer");
    expect(analyzeDocumentMetadata(buildPdf({ creator: "Adobe Photoshop 25" }), "application/pdf").flagged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recompression / structural artifacts (criterion 1)
// ---------------------------------------------------------------------------

describe("tampering-consistent structural and compression artifacts", () => {
  it("flags a stale EXIF thumbnail whose aspect ratio no longer matches the image", () => {
    // Image cropped to portrait after capture; the landscape thumbnail was not refreshed.
    const cropped = cleanCameraJpeg({
      width: 2000,
      height: 3000,
      pixelX: 2000,
      pixelY: 3000,
    });
    const result = analyzeDocumentMetadata(cropped, "image/jpeg");
    expect(result.flagged).toBe(true);
    const signal = result.signals.find((s) => s.code === "thumbnail_mismatch");
    expect(signal).toMatchObject({ severity: "high" });
    expect(signal!.evidence).toContain("160x120");
    expect(signal!.evidence).toContain("2000x3000");
  });

  it("flags a second JPEG stream concatenated after the first", () => {
    const stitched = cleanCameraJpeg({ trailing: buildJpeg({ hasExif: false, width: 800, height: 600 }) });
    const result = analyzeDocumentMetadata(stitched, "image/jpeg");
    expect(result.flagged).toBe(true);
    expect(result.signals.find((s) => s.code === "multiple_jpeg_streams")?.severity).toBe("high");
  });

  it("does not flag a single medium signal on its own (data appended after EOI)", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ trailing: Buffer.from("MOTIONPHOTO-VIDEO-DATA") }), "image/jpeg");
    expect(result.signals.map((s) => s.code)).toEqual(["trailing_data_after_end"]);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a single medium signal on its own (EXIF size differs from actual size)", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ width: 1000, height: 750 }), "image/jpeg");
    const signal = result.signals.find((s) => s.code === "dimension_mismatch");
    expect(signal?.evidence).toBe("EXIF 4000x3000 vs actual 1000x750");
    expect(result.flagged).toBe(false);
  });

  it(`flags a document with ${MEDIUM_SIGNALS_TO_FLAG} medium signals together (resized + re-saved later)`, () => {
    const result = analyzeDocumentMetadata(
      cleanCameraJpeg({ width: 1000, height: 750, dateTime: "2026:03:04 18:00:00" }),
      "image/jpeg"
    );
    expect(result.flagged).toBe(true);
    expect(result.signals.map((s) => s.code).sort()).toEqual(["dimension_mismatch", "modified_after_capture"]);
    expect(result.signals.find((s) => s.code === "modified_after_capture")!.evidence).toContain("2026:03:04 18:00:00");
  });

  it("records PNG data appended after IEND as a (single, medium) signal", () => {
    expect(codes(buildPng({ trailing: Buffer.from("PAYLOAD") }), "image/png")).toEqual(["trailing_data_after_end"]);
  });

  it("flags a PDF saved with appended revisions and modified long after creation", () => {
    const result = analyzeDocumentMetadata(
      buildPdf({
        producer: "Microsoft Print To PDF",
        creationDate: "D:20260101090000",
        modDate: "D:20260220150000",
        revisions: 2,
      }),
      "application/pdf"
    );
    expect(result.flagged).toBe(true);
    expect(result.signals.map((s) => s.code).sort()).toEqual(["modified_after_capture", "pdf_incremental_update"]);
    expect(result.signals.find((s) => s.code === "pdf_incremental_update")!.evidence).toBe("2 %%EOF markers");
  });
});

// ---------------------------------------------------------------------------
// Informational signals and format handling
// ---------------------------------------------------------------------------

describe("low-severity context never flags on its own", () => {
  it("notes software-encoded standard quantization tables with the matching quality", () => {
    const result = analyzeDocumentMetadata(cleanCameraJpeg({ lumaTable: ijgLumaTable(90) }), "image/jpeg");
    const signal = result.signals.find((s) => s.code === "standard_quantization_tables");
    expect(signal).toMatchObject({ severity: "low" });
    expect(signal!.evidence).toContain("quality 90");
    expect(result.flagged).toBe(false);
  });

  it("notes EXIF that records no capture device", () => {
    const result = analyzeDocumentMetadata(buildJpeg({ dateTime: CAPTURE, dateTimeOriginal: CAPTURE }), "image/jpeg");
    expect(result.signals.map((s) => s.code)).toContain("no_capture_device");
    expect(result.flagged).toBe(false);
  });

  it("notes a PDF with no metadata at all", () => {
    const result = analyzeDocumentMetadata(buildPdf(), "application/pdf");
    expect(result.signals.map((s) => s.code)).toEqual(["no_pdf_metadata"]);
    expect(result.flagged).toBe(false);
  });
});

describe("format detection", () => {
  it("detects the real format from magic bytes rather than the claimed MIME type", () => {
    expect(detectFormat(buildJpeg())).toBe("jpeg");
    expect(detectFormat(buildPng())).toBe("png");
    expect(detectFormat(buildPdf())).toBe("pdf");
    expect(detectFormat(Buffer.from("just text"))).toBe("unknown");
  });

  it("records a MIME mismatch (a PDF uploaded as image/jpeg) as a medium signal", () => {
    const result = analyzeDocumentMetadata(buildPdf({ producer: "Microsoft Print To PDF" }), "image/jpeg");
    expect(result.signals.map((s) => s.code)).toContain("mime_type_mismatch");
    expect(result.signals.find((s) => s.code === "mime_type_mismatch")!.evidence).toBe(
      "declared image/jpeg, actual application/pdf"
    );
    expect(result.flagged).toBe(false);
  });

  it("returns no signals and no flag for unrecognized or empty content", () => {
    expect(analyzeDocumentMetadata(Buffer.alloc(0), "image/jpeg")).toEqual({ format: "unknown", flagged: false, signals: [] });
    expect(analyzeDocumentMetadata(Buffer.from("garbage bytes"), "application/pdf").flagged).toBe(false);
  });

  it("survives a truncated JPEG without throwing", () => {
    const truncated = cleanCameraJpeg().subarray(0, 60);
    expect(() => analyzeDocumentMetadata(truncated, "image/jpeg")).not.toThrow();
  });
});

describe("flag policy", () => {
  const sig = (severity: "high" | "medium" | "low") => ({ code: "x", severity, description: "", evidence: "" });

  it("flags on any high signal, on enough medium signals, and never on lows alone", () => {
    expect(evaluateFlagPolicy([sig("high")])).toBe(true);
    expect(evaluateFlagPolicy([sig("medium")])).toBe(false);
    expect(evaluateFlagPolicy([sig("medium"), sig("medium")])).toBe(true);
    expect(evaluateFlagPolicy([sig("low"), sig("low"), sig("low")])).toBe(false);
    expect(evaluateFlagPolicy([])).toBe(false);
  });
});
