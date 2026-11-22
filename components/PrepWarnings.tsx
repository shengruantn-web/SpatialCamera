"use client";
/**
 * HEIC conversion progress and warn-only photo checks (PRD R1.3, R1.6). Every warning is written
 * out in words (icons are decorative), and a polite live region announces when conversion and
 * checks start and finish — not every progress tick.
 */
import { CircleCheck, Copy, Focus, Info, TriangleAlert } from "lucide-react";
import { RECOMMENDED_MIN_PHOTOS } from "../lib/capture-prep/metrics";
import type { CapturePrep, ConversionRecord } from "./useCapturePrep";

type Props = {
  prep: CapturePrep;
  files: readonly { file: File }[];
  /** Below this many photos the page already asks for more, so count guidance is not repeated. */
  minImages: number;
  /** Remove these photos from the selection. */
  onRemove(files: File[]): void;
  disabled?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const NAMES_SHOWN = 6;
function nameList(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}
function statusText(record: ConversionRecord): string {
  switch (record.status) {
    case "queued": return "Waiting";
    case "loading-decoder": return "Downloading the HEIC converter";
    case "decoding": return "Decoding";
    case "encoding": return "Saving as JPEG";
    case "failed": return `Not added: ${record.message}`;
    case "done": {
      const reduced = (record.quality !== undefined && record.quality < 0.92) || (record.scale !== undefined && record.scale < 1);
      return `Converted to JPEG${record.bytes ? `, ${megabytes(record.bytes)}` : ""}${reduced ? " (reduced to fit the 20 MB limit)" : ""}`;
    }
  }
}

export default function PrepWarnings({ prep, files, minImages, onRemove, disabled }: Props) {
  const { conversions, converting, checked, checking, report, supported } = prep;
  const finished = conversions.filter(r => r.status === "done" || r.status === "failed").length;
  const failed = conversions.filter(r => r.status === "failed");
  const loadingDecoder = conversions.some(r => r.status === "loading-decoder");

  const blurry = report.blurry.map(i => files[i]?.file).filter((f): f is File => !!f);
  const extraCopies = report.duplicateGroups.flatMap(group => group.filter(i => report.redundant.includes(i) && !report.blurry.includes(i)))
    .map(i => files[i]?.file).filter((f): f is File => !!f);
  const duplicatePhotos = report.duplicateGroups.reduce((n, g) => n + g.length, 0);
  const done = files.length > 0 && !checking;
  const usable = done ? report.usable : files.length;
  const showCount = files.length >= minImages && usable < RECOMMENDED_MIN_PHOTOS && (done || files.length < RECOMMENDED_MIN_PHOTOS);

  const conversionAnnouncement = conversions.length === 0 ? ""
    : converting ? `Converting ${plural(conversions.length, "HEIC photo")} to JPEG.`
    : `Converted ${conversions.length - failed.length} of ${plural(conversions.length, "HEIC photo")}.${failed.length ? ` ${plural(failed.length, "photo")} could not be converted.` : ""}`;
  const findings = [
    blurry.length && `${plural(blurry.length, "photo")} possibly blurry`,
    report.duplicateGroups.length && plural(report.duplicateGroups.length, "group") + " of near-duplicates",
    showCount && `${usable} usable, ${RECOMMENDED_MIN_PHOTOS} or more recommended`,
  ].filter(Boolean);
  const checkAnnouncement = !supported || files.length === 0 ? ""
    : checking ? `Checking ${plural(files.length, "photo")} for blur and duplicates.`
    : `Checked ${plural(files.length, "photo")}: ${findings.length ? findings.join("; ") : "no blur or duplicates found"}.`;

  return <div className="prep">
    <p className="sr-only" role="status" aria-live="polite">{[conversionAnnouncement, checkAnnouncement].filter(Boolean).join(" ")}</p>
    {conversions.length > 0 && <section className="prep-box" aria-label="HEIC conversion">
      <div className="prep-head">
        <strong>{converting ? `Converting HEIC photos · ${finished} of ${conversions.length}` : `HEIC photos converted · ${conversions.length - failed.length} of ${conversions.length}`}</strong>
        {!converting && <button type="button" className="prep-link" onClick={prep.dismissConversions}>Dismiss</button>}
      </div>
      {converting && <progress value={finished} max={conversions.length} aria-label="HEIC conversion progress" />}
      {loadingDecoder && <p className="prep-note">Downloading the HEIC converter (about 2 MB, first time only)…</p>}
      {failed.length > 0 && <ul className="prep-list prep-failed">{failed.map(r => <li key={r.key}><TriangleAlert size={13} aria-hidden="true" /><span><strong>{r.name}</strong> was not added. {r.message}</span></li>)}</ul>}
      <details><summary>Status of each photo</summary><ul className="prep-files">{conversions.map(r => <li key={r.key}><span>{r.name}</span> — {statusText(r)}</li>)}</ul></details>
    </section>}
    {files.length > 0 && <section className="prep-box" aria-label="Photo checks">
      {!supported ? <p className="prep-note"><Info size={13} aria-hidden="true" /> Automatic blur and duplicate checks are not available in this browser.</p>
        : checking ? <>
          <div className="prep-head"><strong>Checking photos for blur and duplicates · {checked} of {files.length}</strong></div>
          <progress value={checked} max={files.length} aria-label="Photo check progress" />
        </> : findings.length === 0 ? <p className="prep-ok"><CircleCheck size={13} aria-hidden="true" /> Checked {plural(files.length, "photo")}: no blur or near-duplicates found.</p> : null}
      <ul className="prep-list">
        {done && blurry.length > 0 && <li><Focus size={13} aria-hidden="true" /><span>
          <strong>Warning: {plural(blurry.length, "photo")} may be blurry or low in detail.</strong> These often fail to align: {nameList(blurry.map(f => f.name))}.
          <button type="button" className="prep-link" disabled={disabled} onClick={() => onRemove(blurry)}>Remove {plural(blurry.length, "blurry photo")}</button>
        </span></li>}
        {done && report.duplicateGroups.length > 0 && <li><Copy size={13} aria-hidden="true" /><span>
          <strong>Warning: {duplicatePhotos} photos are near-duplicates</strong> ({plural(report.duplicateGroups.length, "group")}). Near-identical shots add processing time but no new viewpoint: {report.duplicateGroups.slice(0, NAMES_SHOWN).map(g => g.map(i => files[i]?.file.name).join(" ≈ ")).join("; ")}{report.duplicateGroups.length > NAMES_SHOWN ? "; …" : ""}.
          {extraCopies.length > 0 && <button type="button" className="prep-link" disabled={disabled} onClick={() => onRemove(extraCopies)}>Remove {plural(extraCopies.length, "extra copy", "extra copies")} (keeps the sharpest of each group)</button>}
        </span></li>}
        {showCount && <li><Info size={13} aria-hidden="true" /><span>
          <strong>Warning: {done && usable < files.length ? `only ${usable} of ${files.length} photos look usable` : `${plural(files.length, "photo")} selected`}.</strong> With fewer than {RECOMMENDED_MIN_PHOTOS} usable photos, camera alignment may fail. Add more overlapping photos from new positions if you can.
        </span></li>}
      </ul>
      {(findings.length > 0 || failed.length > 0) && <p className="prep-note">These are warnings only. You can still create your splat.</p>}
    </section>}
  </div>;
}
