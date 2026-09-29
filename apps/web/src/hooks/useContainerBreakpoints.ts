import { useEffect, useRef, useState, type RefObject } from 'react';
import { breakpoint } from '@widedrop/shared';

/**
 * The prototype's responsive model, reproduced.
 *
 * It watches the *containers* rather than the viewport, which is what makes the
 * layout behave correctly inside a narrow panel, a split window or an embedded
 * frame — a media query only knows how wide the window is, not how much room
 * this particular column has.
 *
 *   shell  < 880px  ->  compact: the sidebar becomes a header and a tab bar
 *   main   < 820px  ->  narrow:  every two-column split collapses to one
 *
 * Without ResizeObserver the layout falls back to the expanded arrangement,
 * which is the safe end: a wide layout in a narrow window scrolls, whereas a
 * collapsed layout in a wide window wastes it.
 */
export interface ContainerBreakpoints {
  compact: boolean;
  narrow: boolean;
  /** Either condition. Drives all four grid templates together. */
  stack: boolean;
}

export function useContainerBreakpoints(
  shellRef: RefObject<HTMLElement | null>,
  mainRef: RefObject<HTMLElement | null>,
  /** Forces a state, for the prototype's Desktop/Mobile preview toggle. */
  override?: 'auto' | 'desktop' | 'mobile',
): ContainerBreakpoints {
  const [compact, setCompact] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    const shell = shellRef.current;
    const main = mainRef.current;

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      // Measurements are batched into one frame. Setting state per entry would
      // lay out twice for every resize tick.
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        for (const entry of entries) {
          const width = entry.contentRect.width;
          if (entry.target === shell) setCompact(width < breakpoint.compact);
          if (entry.target === main) setNarrow(width < breakpoint.narrow);
        }
      });
    });

    if (shell) observer.observe(shell);
    if (main) observer.observe(main);

    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      observer.disconnect();
    };
  }, [shellRef, mainRef]);

  if (override === 'mobile') return { compact: true, narrow: true, stack: true };
  if (override === 'desktop') return { compact: false, narrow, stack: narrow };

  return { compact, narrow, stack: compact || narrow };
}
