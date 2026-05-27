import { create } from "zustand";
import { detectLanguageFromName } from "../lib/languageDetection";

export interface ScratchpadTab {
  id: string;
  name: string;
  content: string;
  language: string;
}

interface ScratchpadState {
  isOpen: boolean;
  tabs: ScratchpadTab[];
  activeTabId: string | null;

  toggleOpen: () => void;
  createTab: () => void;
  deleteTab: (tabId: string) => void;
  renameTab: (tabId: string, newName: string) => void;
  setContent: (tabId: string, content: string) => void;
  setLanguage: (tabId: string, language: string) => void;
  setActiveTab: (tabId: string) => void;
  reset: () => void;
}

export const useScratchpadStore = create<ScratchpadState>((set) => {
  return {
    isOpen: false,
    tabs: [],
    activeTabId: null,

    toggleOpen: () => {
      set((state) => {
        const nextOpen = !state.isOpen;
        // If opening and no tabs, create first tab
        if (nextOpen && state.tabs.length === 0) {
          const newTab: ScratchpadTab = {
            id: crypto.randomUUID(),
            name: "Untitled 1",
            content: "",
            language: "plaintext",
          };
          return {
            isOpen: true,
            tabs: [newTab],
            activeTabId: newTab.id,
          };
        }
        return { isOpen: nextOpen };
      });
    },

    createTab: () => {
      set((state) => {
        const nextNumber = state.tabs.length + 1;
        const newTab: ScratchpadTab = {
          id: crypto.randomUUID(),
          name: `Untitled ${nextNumber}`,
          content: "",
          language: "plaintext",
        };
        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
    },

    deleteTab: (tabId: string) => {
      set((state) => {
        const filtered = state.tabs.filter((t) => t.id !== tabId);

        // If last tab deleted, close scratchpad
        if (filtered.length === 0) {
          return {
            tabs: [],
            activeTabId: null,
            isOpen: false,
          };
        }

        // If deleted tab was active, switch to next available
        let nextActiveId = state.activeTabId;
        if (nextActiveId === tabId) {
          nextActiveId = filtered[0].id;
        }

        return {
          tabs: filtered,
          activeTabId: nextActiveId,
        };
      });
    },

    renameTab: (tabId: string, newName: string) => {
      set((state) => {
        const trimmed = newName.trim();

        // Don't allow empty names
        if (!trimmed) {
          return state;
        }

        // Check for duplicates
        const exists = state.tabs.some((t) => t.id !== tabId && t.name === trimmed);

        let finalName = trimmed;
        if (exists) {
          // Handle duplicate: insert "1" before the file extension
          const lastDot = trimmed.lastIndexOf('.');
          if (lastDot > 0) {
            // Has extension: insert before extension
            const name = trimmed.slice(0, lastDot);
            const ext = trimmed.slice(lastDot);
            finalName = `${name}1${ext}`;
          } else {
            // No extension: just append "1"
            finalName = `${trimmed}1`;
          }
        }

        const language = detectLanguageFromName(finalName);

        return {
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? { ...t, name: finalName, language }
              : t
          ),
        };
      });
    },

    setContent: (tabId: string, content: string) => {
      console.log(`[ScratchpadStore] setContent called:`, {
        tabId,
        contentLength: content.length,
        contentPreview: content.substring(0, 50),
        timestamp: Date.now(),
      });
      set((state) => {
        const newTabs = state.tabs.map((t) =>
          t.id === tabId ? { ...t, content } : t
        );
        const updatedTab = newTabs.find((t) => t.id === tabId);
        console.log(`[ScratchpadStore] setContent update complete:`, {
          tabId,
          newContentLength: updatedTab?.content.length,
          newContentPreview: updatedTab?.content.substring(0, 50),
        });
        return { tabs: newTabs };
      });
    },

    setLanguage: (tabId: string, language: string) => {
      set((state) => {
        return {
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, language } : t
          ),
        };
      });
    },

    setActiveTab: (tabId: string) => {
      set({ activeTabId: tabId });
    },

    reset: () => {
      set({ isOpen: false, tabs: [], activeTabId: null });
    },
  };
});
