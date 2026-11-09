import { create } from "zustand";

/** The crew import review sheet. `text` is the crew file's content; an empty
 *  string opens the sheet ready for a paste or a file pick. */
interface CrewImportState {
  open: boolean;
  text: string;
  /** Where it came from, for the sheet's eyebrow ("bugfix.octocrew.json"). */
  origin: string | null;
  show: (text?: string, origin?: string | null) => void;
  close: () => void;
}

export const useCrewImportStore = create<CrewImportState>((set) => ({
  open: false,
  text: "",
  origin: null,
  show: (text = "", origin = null) => set({ open: true, text, origin }),
  close: () => set({ open: false, text: "", origin: null }),
}));
