"use client";
/**
 * Client-side capture preparation (PRD R1.3, R1.6): HEIC → JPEG conversion before files are
 * accepted, and warn-only blur / near-duplicate / count checks on the selection. All decoding and
 * measuring runs in Web Workers (lib/capture-prep/pool.ts) so a 200-photo selection stays responsive.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyByNameAndType, jpegName, sniffHeic } from "../lib/capture-prep/heic";
import { buildPrepReport, type PrepReport } from "../lib/capture-prep/metrics";
import { analysisPool, heicPool, prepSupported } from "../lib/capture-prep/pool";
import type { ConversionStage } from "../lib/capture-prep/protocol";

export type ConversionStatus = "queued" | ConversionStage | "done" | "failed";
export type ConversionRecord = { key: number; name: string; status: ConversionStatus; message?: string; bytes?: number; quality?: number; scale?: number };
type Measurement = { blur: number | null; hash: string | null; failed?: boolean };

export type CapturePrep = {
  /** Replace HEIC/HEIF files with converted JPEGs (order kept). Files that fail are dropped and reported. */
  convertHeic(incoming: File[]): Promise<File[]>;
  converting: boolean;
  conversions: ConversionRecord[];
  dismissConversions(): void;
  /** False where Workers/OffscreenCanvas are missing: checks are skipped, HEIC cannot be converted. */
  supported: boolean;
  checked: number;
  checking: boolean;
  report: PrepReport;
};

const UNSUPPORTED_HEIC = "This browser cannot convert HEIC photos. Update it, or export the photos as JPEG and add them again.";

async function isHeic(file: File): Promise<boolean> {
  const byName = classifyByNameAndType(file.name, file.type);
  if (byName !== "unknown") return byName === "heic";
  try { return sniffHeic(new Uint8Array(await file.slice(0, 64).arrayBuffer())); } catch { return false; }
}

export function useCapturePrep(files: readonly { file: File }[]): CapturePrep {
  const [supported] = useState(() => typeof window === "undefined" || prepSupported());
  const [batches, setBatches] = useState(0);
  const [conversions, setConversions] = useState<ConversionRecord[]>([]);
  const [measurements, setMeasurements] = useState<ReadonlyMap<File, Measurement>>(() => new Map());
  const [prevCount, setPrevCount] = useState(files.length);
  const nextKey = useRef(1);
  /** Converted output per source file, so re-adding the same HEIC does not convert it again. */
  const converted = useRef(new Map<string, File>());
  const pending = useRef(new Set<File>());
  const buffer = useRef(new Map<File, Measurement>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(files);

  // Starting over (Clear / new capture) clears old conversion results. Adjusting state during render
  // is React's recommended pattern for resetting state when a prop changes.
  if (files.length !== prevCount) {
    setPrevCount(files.length);
    if (files.length === 0 && batches === 0) setConversions([]);
  }

  const update = useCallback((key: number, patch: Partial<ConversionRecord>) =>
    setConversions(list => list.map(record => record.key === key ? { ...record, ...patch } : record)), []);

  const convertHeic = useCallback(async (incoming: File[]): Promise<File[]> => {
    const flags = await Promise.all(incoming.map(isHeic));
    if (!flags.some(Boolean)) return incoming;
    const batch: ConversionRecord[] = [];
    const keys = flags.map((heic, i) => {
      if (!heic) return 0;
      const key = nextKey.current++;
      batch.push({ key, name: incoming[i].name, status: prepSupported() ? "queued" : "failed", message: prepSupported() ? undefined : UNSUPPORTED_HEIC });
      return key;
    });
    // Finished records from earlier batches give way; a batch still converting stays visible.
    setConversions(list => [...list.filter(r => r.status !== "done" && r.status !== "failed"), ...batch]);
    if (!prepSupported()) return incoming.filter((_, i) => !flags[i]);
    setBatches(n => n + 1);
    try {
      const results = await Promise.all(incoming.map(async (file, i): Promise<File | null> => {
        if (!flags[i]) return file;
        const key = keys[i];
        const cacheKey = `${file.name}:${file.size}:${file.lastModified}`;
        const cached = converted.current.get(cacheKey);
        if (cached) { update(key, { status: "done", bytes: cached.size }); return cached; }
        const result = await heicPool().run(file, message => { if (message.type === "stage") update(key, { status: message.stage }); });
        if (result.type === "error") { update(key, { status: "failed", message: result.message }); return null; }
        if (result.type !== "done") return null;
        const jpeg = new File([result.blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
        converted.current.set(cacheKey, jpeg);
        update(key, { status: "done", bytes: jpeg.size, quality: result.quality, scale: result.scale });
        return jpeg;
      }));
      return results.filter((file): file is File => file !== null);
    } finally {
      setBatches(n => n - 1);
    }
  }, [update]);

  const dismissConversions = useCallback(() => setConversions([]), []);

  // Measure every newly selected photo once; results arrive in small batches to limit re-renders.
  useEffect(() => {
    live.current = files;
    if (files.length === 0) converted.current.clear();
    if (!supported) return;
    const flush = () => {
      flushTimer.current = undefined;
      const present = new Set(live.current.map(item => item.file));
      const arrived = buffer.current; buffer.current = new Map();
      setMeasurements(previous => {
        const next = new Map<File, Measurement>();
        for (const source of [previous, arrived]) for (const [file, m] of source) if (present.has(file)) next.set(file, m);
        return next;
      });
    };
    for (const { file } of files) {
      if (pending.current.has(file) || measurements.has(file)) continue;
      pending.current.add(file);
      void analysisPool().run(file).then(result => {
        pending.current.delete(file);
        buffer.current.set(file, result.type === "done" ? { blur: result.blur, hash: result.hash } : { blur: null, hash: null, failed: true });
        flushTimer.current ??= setTimeout(flush, 120);
      });
    }
  }, [files, measurements, supported]);
  useEffect(() => () => clearTimeout(flushTimer.current), []);

  const checked = useMemo(() => files.filter(item => measurements.has(item.file)).length, [files, measurements]);
  const report = useMemo(() => buildPrepReport(files.map(item => measurements.get(item.file) ?? { blur: null, hash: null })), [files, measurements]);
  return { convertHeic, converting: batches > 0, conversions, dismissConversions, supported, checked, checking: supported && checked < files.length, report };
}
