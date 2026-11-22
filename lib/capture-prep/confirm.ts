/**
 * Pure rules for the bulk-removal confirmation in components/PrepWarnings.tsx (S6 review items 1
 * and 4): when a pending confirmation still stands, and where focus goes when it closes.
 */

export type Confirmation<T> = {
  /** Which "Review and remove…" button opened it; focus returns there on cancel. */
  opener: string;
  /** Why these photos are listed, e.g. "low detail or blurry". */
  what: string;
  files: readonly T[];
};

/**
 * The confirmation as it stands against the current selection, or null when it must close:
 * removal is disabled, checks are running again (photos were added, so the findings change), or
 * none of its photos are still selected. Photos removed meanwhile drop out of the list.
 */
export function standingConfirmation<T>(
  pending: Confirmation<T> | null,
  selected: readonly T[],
  { disabled, checking }: { disabled: boolean; checking: boolean },
): Confirmation<T> | null {
  if (!pending || disabled || checking) return null;
  const live = new Set(selected);
  const files = pending.files.filter(file => live.has(file));
  if (files.length === 0) return null;
  return files.length === pending.files.length ? pending : { ...pending, files };
}

export type CloseReason = "cancel" | "remove" | "invalidated";

/**
 * Where focus goes after the confirmation closes. Cancelling returns to the button that opened it
 * when that button can still take focus. Otherwise focus moves to the checks heading, but only if
 * it was lost with the confirmation (an upload starting elsewhere keeps its own focus).
 */
export function focusAfterClose(reason: CloseReason, { openerFocusable, focusLost }: { openerFocusable: boolean; focusLost: boolean }): "opener" | "heading" | null {
  if (reason === "cancel" && openerFocusable) return "opener";
  return focusLost || reason !== "invalidated" ? "heading" : null;
}
