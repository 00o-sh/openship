"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n-provider";

type DesktopBridge = {
  isDesktop?: boolean;
  /** NOTE: platform lives under `app`, not at the top level of the bridge.
   *  Reading `desktop.platform` yields undefined, which makes macOS fall through
   *  to the Windows branch: it draws ─ □ ✕ AND skips the traffic-light inset, so
   *  the native lights land on top of the brand. */
  app?: { platform?: string };
  window?: {
    minimize: () => Promise<unknown>;
    toggleMaximize: () => Promise<unknown>;
    close: () => Promise<unknown>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  };
};

const bridge = (): DesktopBridge | undefined =>
  (window as unknown as { desktop?: DesktopBridge }).desktop;

/**
 * The desktop app's own header bar.
 *
 * This is a REAL row, not an overlay. It used to be an invisible fixed strip with
 * no layout height, which meant every element that happened to sit near the top
 * had to be padded out of its way by hand (`.is-desktop .app-sidebar-header`,
 * `[data-app-topinset]`) — the app looked inflated at the top and the hacks had to
 * be maintained per surface. Now it occupies its own height via a body inset, so
 * page content simply starts below it.
 *
 * Window controls are platform-split on purpose:
 *   - macOS keeps its NATIVE traffic lights (`titleBarStyle: "hiddenInset"`), so
 *     we only reserve space for them. That preserves the green-button fullscreen
 *     menu and hover behaviour, and leaves the window closable by mouse even if
 *     this renderer stalls.
 *   - Windows/Linux run frameless, so we draw ─ □ ✕ ourselves.
 *
 * No-op in a browser (web / SaaS).
 */
export function DesktopChrome() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const d = bridge();
    if (!d?.isDesktop) return;
    const mac = d.app?.platform === "darwin";
    setIsMac(mac);
    setReady(true);

    const root = document.documentElement;
    root.classList.add("is-desktop");
    if (mac) root.classList.add("is-desktop-mac");

    void d.window?.isMaximized().then(setMaximized).catch(() => {});
    const off = d.window?.onMaximizedChange(setMaximized);

    return () => {
      off?.();
      root.classList.remove("is-desktop", "is-desktop-mac");
    };
  }, []);

  /* macOS zooms the window on a double-click anywhere in a drag region, so an
   * accidental double-click near the top used to throw the app fullscreen. Own
   * the gesture instead of letting the OS have it: one deliberate toggle. */
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void bridge()?.window?.toggleMaximize();
  }, []);

  if (!ready) return null;

  return (
    <header className="app-titlebar" onDoubleClick={onDoubleClick}>
      {/* No brand here on purpose. The sidebar header already renders the mark +
          "Openship" directly below this row, so repeating it put the same logo
          twice within ~40px. The bar's job is the drag region and the window
          controls; the app identifies itself once, in the sidebar. */}
      <div className="app-titlebar-spacer" />

      {/* Windows/Linux only — macOS draws the real traffic lights over the
          reserved inset at the start of the bar. */}
      {!isMac && (
        <div className="app-titlebar-controls">
          <button
            type="button"
            className="app-titlebar-btn"
            onClick={() => void bridge()?.window?.minimize()}
            aria-label={t.chrome.window.minimize}
            title={t.chrome.window.minimize}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6h8" />
            </svg>
          </button>
          <button
            type="button"
            className="app-titlebar-btn"
            onClick={() => void bridge()?.window?.toggleMaximize()}
            aria-label={
              maximized
                ? t.chrome.window.restore
                : t.chrome.window.maximize
            }
            title={
              maximized
                ? t.chrome.window.restore
                : t.chrome.window.maximize
            }
          >
            {maximized ? (
              /* Overlapping squares = restore down, the standard Windows glyph. */
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.5 3.5V2.5h6v6h-1" />
                <rect x="2.5" y="4.5" width="5" height="5" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="app-titlebar-btn app-titlebar-btn--close"
            onClick={() => void bridge()?.window?.close()}
            aria-label={t.chrome.window.close}
            title={t.chrome.window.close}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}
