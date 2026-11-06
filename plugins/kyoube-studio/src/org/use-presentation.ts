/**
 * Presentation mode for OrgChart: the tour's state and timer, the keys, and full screen
 * (or filling the window when the browser refuses). The chart moves the view to each stop.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { chartKeyAction } from "./org-chart-parts.js";
import { startTour, tourStep, type TourEvent, type TourStop } from "./org-tour.js";

/** How often the tour checks whether a stop's time is up. */
const TICK_MS = 250;

export interface Presentation {
  /** The tour's stop. It can run past the end of shrunk stops until the next tick clamps it. */
  index: number;
  /** Someone panned or zoomed, so the tour holds still until 15 s pass with no input. */
  manual: boolean;
  /** Full screen is missing or was refused, so the chart fills the window instead (`ko-fill`). */
  fill: boolean;
  /** Reports a pan or zoom. Does nothing outside presentation; the same function every render. */
  noteManual: () => void;
}

export function usePresentation({ present, onPresentChange, rootRef, stops }: {
  present: boolean;
  onPresentChange: (present: boolean) => void;
  rootRef: RefObject<HTMLElement | null>;
  stops: TourStop[];
}): Presentation {
  const [tour, setTour] = useState(() => startTour(Date.now()));
  const [fill, setFill] = useState(false);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const presentRef = useRef(present);
  presentRef.current = present;
  const changeRef = useRef(onPresentChange);
  changeRef.current = onPresentChange;

  const send = useCallback((type: TourEvent["type"]) => setTour((s) => tourStep(s, { type, now: Date.now() }, stopsRef.current)), []);
  const noteManual = useCallback(() => {
    if (presentRef.current) send("manual");
  }, [send]);

  // Each presentation starts at the overview, then the timer moves it on. Leaving resets the tour too,
  // so the first frame of the next presentation is the overview, not the stop this one ended on.
  useEffect(() => {
    if (!present) return;
    setTour(startTour(Date.now()));
    const id = setInterval(() => send("tick"), TICK_MS);
    return () => {
      clearInterval(id);
      setTour(startTour(Date.now()));
    };
  }, [present, send]);

  // Space pauses, the arrows step, Esc leaves and does nothing else.
  useEffect(() => {
    if (!present || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const action = chartKeyAction(e, { present: true, hasSelection: false });
      if (action === null || action === "clear-selection") return;
      e.preventDefault();
      if (action === "leave-present") changeRef.current(false);
      else send(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [present, send]);

  // Full screen, or fill the window when that is missing or refused. Leaving full screen leaves presentation.
  useEffect(() => {
    const el = rootRef.current;
    if (!present || !el || typeof document === "undefined") return;
    let live = true;
    const fallback = () => {
      if (live) setFill(true);
    };
    if (typeof el.requestFullscreen !== "function") fallback();
    else {
      try {
        Promise.resolve(el.requestFullscreen()).catch(fallback);
      } catch {
        fallback();
      }
    }
    const onChange = () => {
      if (!document.fullscreenElement) changeRef.current(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === el && typeof document.exitFullscreen === "function") {
        try {
          Promise.resolve(document.exitFullscreen()).catch(() => {});
        } catch {
          // Already leaving.
        }
      }
      setFill(false);
    };
  }, [present, rootRef]);

  return { index: tour.index, manual: tour.manualAt !== null, fill, noteManual };
}
