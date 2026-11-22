"use client";
/**
 * HEIC conversion progress and warn-only photo checks (PRD R1.3, R1.6). Every warning is written
 * out in words (icons are decorative), and a polite live region announces when conversion and
 * checks start and finish — not every progress tick — including why photos were not added.
 * Bulk removal always asks first, listing what goes. The confirmation takes focus when it opens
 * (Escape cancels); cancelling returns focus to the button that opened it, removing moves it to the
 * checks heading. It closes by itself when its photos are gone, checks rerun, or removal is disabled.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CircleCheck, Copy, Focus, Info, TriangleAlert } from "lucide-react";
import { focusAfterClose, standingConfirmation, type CloseReason, type Confirmation } from "../lib/capture-prep/confirm";
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
/** Failure reasons read out by the live region; the rest are on screen. */
const REASONS_ANNOUNCED = 3;
function nameList(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}
const settled = (r: ConversionRecord) => r.status === "done" || r.status === "failed" || r.status === "cancelled";
function statusText(record: ConversionRecord): string {
  switch (record.status) {
    case "queued": return "Waiting";
    case "loading-decoder": return "Downloading the HEIC converter";
    case "decoding": return "Decoding";
    case "encoding": return "Saving as JPEG";
    case "failed": return `Not added: ${record.message}`;
    case "cancelled": return "Not added: conversion cancelled";
    case "done": {
      const reduced = (record.quality !== undefined && record.quality < 0.92) || (record.scale !== undefined && record.scale < 1);
      return `Converted to JPEG${record.bytes ? `, ${megabytes(record.bytes)}` : ""}${reduced ? " (reduced to fit the 20 MB limit)" : ""}`;
    }
  }
}

type Opener = "blurry" | "copies";

export default function PrepWarnings({ prep, files, minImages, onRemove, disabled }: Props) {
  const { conversions, converting, checked, checking, report, supported } = prep;
  const [pending, setPending] = useState<Confirmation<File> | null>(null);
  const [removed, setRemoved] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const openers = useRef<Partial<Record<Opener, HTMLButtonElement | null>>>({});
  /** Why the confirmation is closing; anything not set by its buttons counts as "invalidated". */
  const closing = useRef<{ reason: CloseReason; opener?: Opener }>({ reason: "invalidated" });
  const wasOpen = useRef(false);
  const finished = conversions.filter(settled).length;
  const failed = conversions.filter(r => r.status === "failed");
  const cancelled = conversions.filter(r => r.status === "cancelled");
  const notAdded = failed.length + cancelled.length;
  const inProgress = converting && finished < conversions.length;
  const loadingDecoder = conversions.some(r => r.status === "loading-decoder");

  const toFiles = (indices: number[]) => indices.map(i => files[i]?.file).filter((f): f is File => !!f);
  const blurry = toFiles(report.blurry);
  const extraCopies = toFiles(report.extraCopies);
  const duplicatePhotos = report.duplicateGroups.reduce((n, g) => n + g.length, 0);
  const done = files.length > 0 && !checking;
  const usable = done ? report.usable : files.length;
  const showCount = files.length >= minImages && usable < RECOMMENDED_MIN_PHOTOS && (done || files.length < RECOMMENDED_MIN_PHOTOS);
  // Review item 4: a confirmation only stands while removal is possible, checks are settled and
  // some of its photos are still selected; otherwise it is dropped for good, not just hidden.
  const confirm = standingConfirmation(pending, files.map(item => item.file), { disabled: !!disabled, checking: !done });
  if (pending && !confirm) setPending(null);
  const open = confirm !== null;

  // Review item 1: the confirmation takes focus when it opens; when it closes, focus goes back to
  // the opener (cancel) or to the checks heading, never to <body>.
  useEffect(() => {
    if (open) group.current?.focus();
    else if (wasOpen.current) {
      const { reason, opener: key } = closing.current;
      const opener = key ? openers.current[key] : null;
      const active = document.activeElement;
      const target = focusAfterClose(reason, { openerFocusable: !!opener?.isConnected && !opener.disabled, focusLost: !active || active === document.body });
      if (target === "opener") opener?.focus();
      else if (target === "heading") heading.current?.focus();
    }
    closing.current = { reason: "invalidated" };
    wasOpen.current = open;
  }, [open]);

  function ask(opener: Opener, what: string, list: File[]) { setRemoved(""); setPending({ opener, what, files: list }); }
  function cancel() { closing.current = { reason: "cancel", opener: confirm?.opener as Opener | undefined }; setPending(null); }
  function remove() {
    if (!confirm) return;
    closing.current = { reason: "remove" };
    onRemove([...confirm.files]);
    setPending(null);
    setRemoved(`Removed ${plural(confirm.files.length, "photo")} (${confirm.what}).`);
  }
  function onConfirmKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  const reasons = failed.slice(0, REASONS_ANNOUNCED).map(r => `${r.name}: ${r.message}`).join(" ");
  const conversionAnnouncement = conversions.length === 0 ? ""
    : inProgress ? `Converting ${plural(conversions.length, "HEIC photo")} to JPEG.`
    : `Converted ${conversions.length - notAdded} of ${plural(conversions.length, "HEIC photo")}.`
      + (failed.length ? ` ${plural(failed.length, "photo")} could not be added. ${reasons}${failed.length > REASONS_ANNOUNCED ? " More details are listed on screen." : ""}` : "")
      + (cancelled.length ? ` ${plural(cancelled.length, "photo")} not converted because conversion was cancelled.` : "");
  const findings = [
    blurry.length && `${plural(blurry.length, "photo")} low detail or blurry`,
    report.duplicateGroups.length && plural(report.duplicateGroups.length, "group") + " of near-duplicates",
    showCount && `${usable} usable, ${RECOMMENDED_MIN_PHOTOS} or more recommended`,
  ].filter(Boolean);
  const checkAnnouncement = !supported || files.length === 0 ? ""
    : checking ? `Checking ${plural(files.length, "photo")} for blur and duplicates.`
    : `Checked ${plural(files.length, "photo")}: ${findings.length ? findings.join("; ") : "no blur or duplicates found"}.`;

  return <div className="prep">
    <p className="sr-only" role="status" aria-live="polite">{[conversionAnnouncement, removed, checkAnnouncement].filter(Boolean).join(" ")}</p>
    {conversions.length > 0 && <section className="prep-box" aria-label="HEIC conversion">
      <div className="prep-head">
        <strong>{inProgress ? `Converting HEIC photos · ${finished} of ${conversions.length}` : `HEIC photos converted · ${conversions.length - notAdded} of ${conversions.length}`}</strong>
        {inProgress
          ? <button type="button" className="prep-link" onClick={prep.cancelConversions}>Cancel conversion</button>
          : !converting && <button type="button" className="prep-link" onClick={prep.dismissConversions}>Dismiss</button>}
      </div>
      {inProgress && <progress value={finished} max={conversions.length} aria-label="HEIC conversion progress" />}
      {loadingDecoder && <p className="prep-note">Downloading the HEIC converter (about 1.5 MB, first time only)…</p>}
      {failed.length > 0 && <ul className="prep-list prep-failed">{failed.map(r => <li key={r.key}><TriangleAlert size={13} aria-hidden="true" /><span><strong>{r.name}</strong> was not added. {r.message}</span></li>)}</ul>}
      {cancelled.length > 0 && <p className="prep-note">Conversion cancelled: {plural(cancelled.length, "HEIC photo")} not added ({nameList(cancelled.map(r => r.name))}).</p>}
      <details><summary>Status of each photo</summary><ul className="prep-files">{conversions.map(r => <li key={r.key}><span>{r.name}</span> — {statusText(r)}</li>)}</ul></details>
    </section>}
    {files.length > 0 && <section className="prep-box" aria-labelledby="prep-checks-heading">
      <h3 id="prep-checks-heading" className="prep-title" tabIndex={-1} ref={heading}>Photo checks</h3>
      {!supported ? <p className="prep-note"><Info size={13} aria-hidden="true" /> Automatic blur and duplicate checks are not available in this browser.</p>
        : checking ? <>
          <div className="prep-head"><strong>Checking photos for blur and duplicates · {checked} of {files.length}</strong></div>
          <progress value={checked} max={files.length} aria-label="Photo check progress" />
        </> : findings.length === 0 ? <p className="prep-ok"><CircleCheck size={13} aria-hidden="true" /> Checked {plural(files.length, "photo")}: no blur or near-duplicates found.</p> : null}
      {removed && !confirm && <p className="prep-ok"><CircleCheck size={13} aria-hidden="true" /> {removed}</p>}
      {confirm ? <div className="prep-confirm" role="group" aria-labelledby="prep-confirm-question" aria-describedby="prep-confirm-detail" tabIndex={-1} ref={group} onKeyDown={onConfirmKey}>
        <p><strong id="prep-confirm-question">Remove {plural(confirm.files.length, "photo")} ({confirm.what}) from this capture?</strong> <span id="prep-confirm-detail">{nameList(confirm.files.map(f => f.name))}. They stay on your device; you can add them again.</span></p>
        <div className="prep-actions">
          <button type="button" className="prep-button" onClick={remove}>Remove {plural(confirm.files.length, "photo")}</button>
          <button type="button" className="prep-link" onClick={cancel}>Keep them</button>
        </div>
      </div> : <ul className="prep-list">
        {done && blurry.length > 0 && <li><Focus size={13} aria-hidden="true" /><span>
          <strong>Warning: {plural(blurry.length, "photo")} {blurry.length === 1 ? "looks" : "look"} low detail or blurry.</strong> Such photos often fail to align: {nameList(blurry.map(f => f.name))}.
          <button type="button" className="prep-link" disabled={disabled} ref={el => { openers.current.blurry = el; }} onClick={() => ask("blurry", "low detail or blurry", blurry)}>Review and remove {plural(blurry.length, "photo")}…</button>
        </span></li>}
        {done && report.duplicateGroups.length > 0 && <li><Copy size={13} aria-hidden="true" /><span>
          <strong>Warning: {duplicatePhotos} photos are near-duplicates</strong> ({plural(report.duplicateGroups.length, "group")}). Near-identical shots add processing time but no new viewpoint: {report.duplicateGroups.slice(0, NAMES_SHOWN).map(g => g.map(i => files[i]?.file.name).join(" ≈ ")).join("; ")}{report.duplicateGroups.length > NAMES_SHOWN ? "; …" : ""}.
          {extraCopies.length > 0 && <button type="button" className="prep-link" disabled={disabled} ref={el => { openers.current.copies = el; }} onClick={() => ask("copies", "extra copies; the sharpest of each group stays", extraCopies)}>Review and remove {plural(extraCopies.length, "extra copy", "extra copies")}…</button>}
        </span></li>}
        {showCount && <li><Info size={13} aria-hidden="true" /><span>
          <strong>Warning: {done && usable < files.length ? `only ${usable} of ${files.length} photos look usable` : `${plural(files.length, "photo")} selected`}.</strong> With fewer than {RECOMMENDED_MIN_PHOTOS} usable photos, camera alignment may fail. Add more overlapping photos from new positions if you can.
        </span></li>}
      </ul>}
      {(findings.length > 0 || failed.length > 0) && <p className="prep-note">These are warnings only. You can still create your splat.</p>}
    </section>}
  </div>;
}
