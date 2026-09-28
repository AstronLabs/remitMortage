# KYC Document Forgery Detection (Metadata Analysis)

> Issue #813. Every uploaded ID document gets an automated metadata pass. A
> suspicious result **flags the document for manual review** — it never
> rejects the upload or blocks the applicant, because legitimate scans can
> also lack rich metadata.

Implementation: `backend/src/services/documentForensics.ts` (pure analysis),
`backend/src/services/kycDocumentForensics.ts` (recording + review queue),
hooked into `POST /api/kyc/:address/upload`.

## What it checks

The analysis reads the file's own structure and tags — no pixel decoding.
The real format is detected from magic bytes, not the claimed MIME type.

| Signal | Severity | What it means / what to look at |
|---|---|---|
| `editing_software_signature` | high | An editor (Photoshop, GIMP, Paint.NET, Pixelmator, Canva, Sejda, …) is named in EXIF `Software`, XMP `CreatorTool`, a JPEG comment, PNG text, or a PDF `Producer`/`Creator`. The evidence names the tag and value. |
| `photoshop_resource_block` | high | Photoshop's APP13 block — written when saved from Photoshop. |
| `edit_history_present` | high | XMP edit history (`stEvt`/`xmpMM:History`). The evidence lists the recorded actions and software. |
| `thumbnail_mismatch` | high | The embedded EXIF thumbnail's aspect ratio no longer matches the image: it was cropped/edited by software that did not refresh the thumbnail. The evidence gives both sizes. |
| `multiple_jpeg_streams` | high | A second JPEG is concatenated after the first — not a single capture. |
| `dimension_mismatch` | medium | EXIF-recorded capture size differs from the actual size (resized/re-saved). |
| `modified_after_capture` | medium | Modification date is later than the original capture/creation date (EXIF: >60s; PDF: >1 day). |
| `trailing_data_after_end` | medium | Bytes appended after the JPEG/PNG end marker. Some phones append motion-photo video — confirm before treating as tampering. |
| `pdf_incremental_update` | medium | PDF saved with appended revisions (multiple `%%EOF`). Also normal for signed/filled forms — compare revisions. |
| `mime_type_mismatch` | medium | Actual format differs from the uploaded type. |
| `no_exif_metadata`, `no_capture_device`, `standard_quantization_tables`, `no_pdf_metadata` | low | Context only. A scan or a messaging-app re-share routinely looks like this, but so does stripped metadata. `standard_quantization_tables` means the JPEG's quantization tables exactly match libjpeg at a given quality (encoded by software). |

## Flag policy

A document is flagged when it has **any `high` signal** or **two or more
`medium` signals**. `low` signals never flag on their own.

## The reviewer workflow

1. **Find flagged documents:** `GET /api/admin/kyc/flagged-documents` lists
   flagged, unreviewed documents (oldest first), each with its full `signals`
   array — code, severity, description and the concrete evidence. The same
   signals are logged at WARN (`Document flagged for manual review: suspicious
   metadata`) and recorded in the audit log as `KYC_DOCUMENT_FLAGGED`.
2. **Inspect the document** with the signals in hand: the signal tells you
   what to look for (e.g. re-typed text after a `thumbnail_mismatch`).
3. **Resolve it:** `POST /api/admin/kyc/flagged-documents/:documentId/review`
   with `{ "outcome": "CLEARED" | "CONFIRMED_TAMPERED", "note": "…" }`. Each
   document is resolved once; the reviewer, time, outcome and note are kept.

## Deliberate design choices

- **Never shown to the uploader.** The upload response is unchanged and does
  not reveal whether a document was flagged or why, so a forger cannot
  iterate against the checks.
- **Flag, don't reject.** Missing metadata alone never flags. High-signal
  documents can still be legitimate (a genuine photo edited in Lightroom for
  brightness) — that is what the human step is for.

## Limits

This reads structure and tags, not pixels. A forger who strips or rewrites
all metadata evades it; the low-severity "no metadata" signals exist to give
reviewers that context. PDF Info dictionaries stored inside compressed object
streams are not inspected. Pixel-domain analysis (error-level analysis,
double-JPEG-quantization histograms) is out of scope for this pass.
