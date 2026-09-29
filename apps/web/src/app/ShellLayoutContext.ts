import { createContext, useContext } from 'react';

/**
 * The shell's measured layout state.
 *
 * Exposed so a component anywhere inside can adapt without measuring again —
 * and without reaching for a media query, which would answer a different
 * question (how wide is the window) from the one that matters (how much room
 * does this layout have).
 */
export interface ShellLayout {
  /** The sidebar has been replaced by a header and a bottom tab bar. */
  compact: boolean;
  /** Two-column splits have collapsed to one. */
  stack: boolean;
}

export const ShellLayoutContext = createContext<ShellLayout>({ compact: false, stack: false });

export function useShellLayout(): ShellLayout {
  return useContext(ShellLayoutContext);
}
