"use client";
/**
 * Client-side capture preparation (PRD R1.3, R1.6): HEIC → JPEG conversion before files are
 * accepted, and warn-only blur / near-duplicate / count checks on the selection. All decoding and
 * measuring runs in Web Workers (lib/capture-prep/pool.ts) so a 200-photo selection stays responsive.
 *
 * Lifecycle rules (review H1/H2/M3/M6):
 *  - One add at a time. `beginAdd()` hands out a ticket whose signal Studio checks after every
 *    await; `converting` stays true until the ticket ends (conversion AND validation), so the
 *    dropzone and the upload button stay disabled for the whole add.
 *  - `reset()` (Clear / new capture) aborts the add in flight, every queued or running worker job
 *    and pending result flushes; results that arrive later are ignored (epoch + mounted guard).
 *  - Photos that leave the selection have their analysis job cancelled and their cached
 *    conversion dropped. The cache is keyed by the source HEIC (name:size:mtime) and kept while
 *    that source's JPEG (under whatever final name) is selected or its add is still running, so
 *    re-adding a folder skips photos already converted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { anySignal } from "../lib/capture-prep/any-signal";
import { classifyByNameAndType, convertedNames, heicOverLimit, jpegName, sniffHeic } from "../lib/capture-prep/heic";
import { buildPrepReport, type PrepReport } from "../lib/capture-prep/metrics";
import { analysisPool, heicPool, prepSupported } from "../lib/capture-prep/pool";
import type { ConversionStage } from "../lib/capture-prep/protocol";

export type ConversionStatus = "queued" | ConversionStage | "done" | "failed" | "cancelled";
export type ConversionRecord = { key: number; name: string; status: ConversionStatus; message?: string; bytes?: number; quality?: number; scale?: number };
type Measurement = { blur: number | null; hash: string | null; failed?: boolean };

/** One add (pick or drop). Studio must call `end()` in a finally block. */
export type AddTicket = { signal: AbortSignal; end(): void };

export type CapturePrep = {
  /** Start an add; null while another add is still running (the dropzone is disabled then). */
  beginAdd(): AddTicket | null;
  /**
   * Replace HEIC/HEIF files with converted JPEGs (order kept). Files that fail are dropped and
   * reported. Only HEICs within the first `slots` positions are converted (review L6); the rest
   * could not be added anyway and are reported as skipped.
   */
  convertHeic(incoming: File[], options: { signal: AbortSignal; slots: number }): Promise<File[]>;
  /** True from `beginAdd()` until its ticket ends. */
  converting: boolean;
  /** Stop converting the remaining HEIC photos of the current add; photos already done are still added. */
  cancelConversions(): void;
  /** Starting over: abort everything in flight and forget all results. */
  reset(): void;
  conversions: ConversionRecord[];
  dismissConversions(): void;
  /** False where Workers/OffscreenCanvas are missing: checks are skipped, HEIC cannot be converted. */
  supported: boolean;
  checked: number;
  checking: boolean;
  report: PrepReport;
};

const UNSUPPORTED_HEIC = "This browser cannot convert HEIC photos. Update it, or export the photos as JPEG and add them again.";
const OVER_LIMIT = "Not converted: the capture would go over the 200-photo limit.";

async function isHeic(file: File): Promise<boolean> {
  const byName = classifyByNameAndType(file.name, file.type);
  if (byName !== "unknown") return byName === "heic";
  try { return sniffHeic(new Uint8Array(await file.slice(0, 64).arrayBuffer())); } catch { return false; }
}


const cacheKeyOf = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export function useCapturePrep(files: readonly { file: File }[]): CapturePrep {
  const [supported] = useState(() => typeof window === "undefined" || prepSupported());
  const [adds, setAdds] = useState(0);
  const [conversions, setConversions] = useState<ConversionRecord[]>([]);
  const [measurements, setMeasurements] = useState<ReadonlyMap<File, Measurement>>(() => new Map());
  const [prevCount, setPrevCount] = useState(files.length);
  const nextKey = useRef(1);
  const mounted = useRef(false);
  /** Bumped by reset(); async work started under an older epoch must not touch state. */
  const epoch = useRef(0);
  /** The add in flight, if any: its own controller, plus one that only stops conversions. */
  const add = useRef<{ controller: AbortController; conversions: AbortController } | null>(null);
  /** Converted output per source HEIC (keyed by name/size/mtime), so re-adding it skips the work. */
  const converted = useRef(new Map<string, File>());
  /** Source key of every converted output, renamed copies included (review item 5). */
  const sourceOf = useRef(new WeakMap<File, string>());
  /** Source keys of the add in flight: their outputs are not selected yet, so the trim spares them. */
  const inFlight = useRef(new Set<string>());
  /** Analysis jobs in flight, by photo; aborted when the photo leaves the selection. */
  const jobs = useRef(new Map<File, AbortController>());
  const buffer = useRef(new Map<File, Measurement>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(files);

  // Selection emptied outside an add (e.g. after a successful upload): old conversion results go.
  // Adjusting state during render is React's recommended pattern for resetting on a prop change.
  if (files.length !== prevCount) {
    setPrevCount(files.length);
    if (files.length === 0 && adds === 0) setConversions([]);
  }

  const beginAdd = useCallback((): AddTicket | null => {
    if (add.current) return null;
    const current = { controller: new AbortController(), conversions: new AbortController() };
    add.current = current;
    setAdds(n => n + 1);
    let ended = false;
    return {
      signal: current.controller.signal,
      end: () => {
        if (ended) return;
        ended = true;
        if (add.current === current) { add.current = null; inFlight.current.clear(); }
        if (mounted.current) setAdds(n => n - 1);
      },
    };
  }, []);

  const convertHeic = useCallback(async (incoming: File[], { signal, slots }: { signal: AbortSignal; slots: number }): Promise<File[]> => {
    const started = epoch.current;
    const alive = () => mounted.current && epoch.current === started && !signal.aborted;
    const flags = await Promise.all(incoming.map(isHeic));
    if (!alive()) return [];
    if (!flags.some(Boolean)) return incoming;
    const canConvert = prepSupported();
    const sources = incoming.map((file, i) => flags[i] ? cacheKeyOf(file) : null);
    const selectedSources = new Set(live.current.flatMap(item => sourceOf.current.get(item.file) ?? []));
    const overLimit = heicOverLimit(sources, slots, selectedSources);
    for (const source of sources) if (source) inFlight.current.add(source);
    const batch: ConversionRecord[] = [];
    const keys = flags.map((heic, i) => {
      if (!heic) return 0;
      const key = nextKey.current++;
      const message = !canConvert ? UNSUPPORTED_HEIC : overLimit[i] ? OVER_LIMIT : undefined;
      batch.push({ key, name: incoming[i].name, status: message ? "failed" : "queued", message });
      return key;
    });
    const update = (key: number, patch: Partial<ConversionRecord>) => {
      if (mounted.current && epoch.current === started) setConversions(list => list.map(record => record.key === key ? { ...record, ...patch } : record));
    };
    // Finished records from earlier adds give way to this batch.
    setConversions(list => [...list.filter(r => r.status !== "done" && r.status !== "failed" && r.status !== "cancelled"), ...batch]);
    if (!canConvert) return incoming.filter((_, i) => !flags[i]);
    const stop = anySignal([signal, add.current?.conversions.signal].filter((s): s is AbortSignal => !!s));
    let results: (File | null)[];
    try {
      results = await Promise.all(incoming.map(async (file, i): Promise<File | null> => {
        const source = sources[i];
        if (!source) return file;
        if (overLimit[i]) return null;
        const key = keys[i];
        const cached = converted.current.get(source);
        if (cached) { update(key, { status: "done", bytes: cached.size }); return cached; }
        const result = await heicPool().run(file, {
          signal: stop.signal,
          onMessage: message => { if (message.type === "stage") update(key, { status: message.stage }); },
        });
        if (result.type === "error") {
          update(key, result.reason === "cancelled" ? { status: "cancelled", message: "Not converted: cancelled." } : { status: "failed", message: result.message });
          return null;
        }
        if (result.type !== "done") return null;
        const jpeg = new File([result.blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
        update(key, { status: "done", bytes: jpeg.size, quality: result.quality, scale: result.scale });
        return jpeg;
      }));
    } finally { stop.dispose(); }
    if (!alive()) return [];
    // Review L4: a converted name must not clash with a different photo already selected or
    // elsewhere in this batch (two uploads under one name confuse the resume matcher).
    const kept = results.flatMap((file, i) => file ? [{ file, source: sources[i] }] : []);
    const names = convertedNames(live.current.map(item => item.file), kept.map(({ file, source }) => ({ name: file.name, size: file.size, converted: !!source })));
    return kept.map(({ file, source }, i) => {
      const final = names[i] === file.name ? file : new File([file], names[i], { type: file.type, lastModified: file.lastModified });
      // Review item 5: cache the file under the name it is added with, keyed by its source.
      if (source) { converted.current.set(source, final); sourceOf.current.set(final, source); }
      return final;
    });
  }, []);

  const cancelConversions = useCallback(() => add.current?.conversions.abort(), []);

  const reset = useCallback(() => {
    epoch.current++;
    add.current?.controller.abort();
    add.current?.conversions.abort();
    jobs.current.forEach(controller => controller.abort());
    jobs.current.clear();
    buffer.current.clear();
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    converted.current.clear();
    inFlight.current.clear();
    setConversions([]);
    setMeasurements(new Map());
  }, []);

  const dismissConversions = useCallback(() => setConversions([]), []);

  // Measure every newly selected photo once; results arrive in small batches to limit re-renders.
  useEffect(() => {
    live.current = files;
    const present = new Set(files.map(item => item.file));
    // Photos that left the selection: stop their checks and forget their converted copies (M3).
    for (const [file, controller] of jobs.current) if (!present.has(file)) { controller.abort(); jobs.current.delete(file); }
    const liveSources = new Set(files.flatMap(item => sourceOf.current.get(item.file) ?? []));
    for (const source of converted.current.keys()) if (!liveSources.has(source) && !inFlight.current.has(source)) converted.current.delete(source);
    if (!supported) return;
    const flush = () => {
      flushTimer.current = undefined;
      if (!mounted.current) return;
      const keep = new Set(live.current.map(item => item.file));
      const arrived = buffer.current; buffer.current = new Map();
      setMeasurements(previous => {
        const next = new Map<File, Measurement>();
        for (const source of [previous, arrived]) for (const [file, m] of source) if (keep.has(file)) next.set(file, m);
        return next;
      });
    };
    for (const { file } of files) {
      if (jobs.current.has(file) || measurements.has(file)) continue;
      const controller = new AbortController();
      jobs.current.set(file, controller);
      const settle = (m: Measurement | null) => {
        // A newer job for the same photo (removed and re-added) owns the slot now.
        if (jobs.current.get(file) !== controller) return;
        jobs.current.delete(file);
        if (!m || !mounted.current) return;
        buffer.current.set(file, m);
        flushTimer.current ??= setTimeout(flush, 120);
      };
      analysisPool().run(file, { signal: controller.signal })
        .then(result => settle(
          result.type === "done" ? { blur: result.blur, hash: result.hash }
          : result.reason === "cancelled" ? null
          : { blur: null, hash: null, failed: true }))
        // run() never rejects; this keeps a bug from leaving "Checking 0 of N" on screen forever (H3).
        .catch(() => settle({ blur: null, hash: null, failed: true }));
    }
  }, [files, measurements, supported]);

  useEffect(() => {
    mounted.current = true;
    const pending = jobs.current;
    return () => {
      mounted.current = false;
      add.current?.controller.abort();
      add.current?.conversions.abort();
      add.current = null;
      pending.forEach(controller => controller.abort());
      pending.clear();
      clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
    };
  }, []);

  const checked = useMemo(() => files.filter(item => measurements.has(item.file)).length, [files, measurements]);
  const report = useMemo(() => buildPrepReport(files.map(item => measurements.get(item.file) ?? { blur: null, hash: null })), [files, measurements]);
  return { beginAdd, convertHeic, converting: adds > 0, cancelConversions, reset, conversions, dismissConversions, supported, checked, checking: supported && checked < files.length, report };
}
