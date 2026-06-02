/** A thin chrome bar at the very top of the app. Mirrors the bottom
 *  `PerfMonitorBar` in structure (full width, hairline border, panel bg)
 *  but sits above the main canvas + companion + rail.
 *
 *  Currently the bar's only purpose is to give the macOS traffic lights
 *  a dedicated home — the Tauri window already runs with
 *  `titleBarStyle: "Overlay"` + `hiddenTitle: true`, so the lights are
 *  drawn over our content at a fixed top-left position. The 78px left
 *  padding reserves room for them; the rest of the bar is a
 *  `data-tauri-drag-region` so the user can drag the window from any
 *  empty space.
 *
 *  Future controls (tabs, mode toggles, anything app-level) will dock
 *  here. */
export function AppTopBar() {
  return (
    <div
      data-tauri-drag-region
      className="flex h-[28px] w-full flex-shrink-0 items-center border-b border-octo-hairline bg-octo-panel pl-[78px] pr-3"
    />
  );
}
