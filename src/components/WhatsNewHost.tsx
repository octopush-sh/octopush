// Mounts the What's new dialog and the tour overlay, runs the post-update
// launch check once, and installs the recorder bridge (`window.__octoTour`)
// in dev / `?octo-record=1`.
import { useEffect } from "react";
import { WhatsNewModal } from "./WhatsNewModal";
import { TourOverlay } from "./TourOverlay";
import { launchOnce } from "../lib/whatsNewLaunch";
import { installTourBridge } from "../lib/tour/bridge";

export function WhatsNewHost() {
  useEffect(() => {
    installTourBridge();
    launchOnce();
  }, []);
  return (
    <>
      <WhatsNewModal />
      <TourOverlay />
    </>
  );
}
