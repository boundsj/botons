import { createContext, useContext, useRef } from 'react';

/** Whether the Settings page holding a component is the one shown. Hidden pages keep their state, not their polling. */
export const PageActive = createContext(true);

/** A ref to PageActive, for a timer to read when it fires. */
export function useActiveRef() {
  const active = useContext(PageActive);
  const ref = useRef(active);
  ref.current = active;
  return ref;
}
