import { create } from "zustand";
import { ipc, type Role } from "../lib/ipc";
import { setArchetypes } from "../components/builder/graph";

interface RolesState {
  roles: Role[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useRolesStore = create<RolesState>((set) => ({
  roles: [],
  loaded: false,
  load: async () => {
    const roles = await ipc.listRoles();
    setArchetypes(roles);
    set({ roles, loaded: true });
  },
}));
