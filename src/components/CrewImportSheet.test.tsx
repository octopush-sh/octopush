import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CrewPreview } from "../lib/ipc";

const previewMock = vi.hoisted(() => vi.fn());
const importMock = vi.hoisted(() => vi.fn());
const createRunMock = vi.hoisted(() => vi.fn());
const startRunMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      previewCrew: previewMock,
      importCrew: importMock,
      createRun: createRunMock,
      startRun: startRunMock,
      listPipelines: vi.fn().mockResolvedValue([]),
      listRoles: vi.fn().mockResolvedValue([]),
      listProviders: vi.fn().mockResolvedValue([
        { name: "anthropic", enabled: true, models: [{ id: "claude-sonnet-4-6" }, { id: "claude-haiku-4-5" }] },
      ]),
    },
  };
});
vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ activeModel, onSelectModel }: { activeModel: string; onSelectModel: (m: string) => void }) => (
    <button onClick={() => onSelectModel("claude-sonnet-4-6")}>model:{activeModel}</button>
  ),
}));

const { CrewImportHost } = await import("./CrewImportSheet");
const { useCrewImportStore } = await import("../stores/crewImportStore");

function stage(over: Partial<CrewPreview["stages"][number]>): CrewPreview["stages"][number] {
  return {
    position: 0, label: "Plan", role: "plan", agentModel: "claude-haiku-4-5", escalateModel: null,
    substrate: "api", cliDialect: null, checkpoint: false, readOnly: true, actionRole: false, tools: ["read_file"],
    instructions: null, effort: null, escalateEffort: null, loopTargetPosition: null, loopMode: null,
    loopMaxIterations: 0, unpricedModel: false, unpricedEscalate: false, warnings: [], problem: null, ...over,
  };
}

const GOOD: CrewPreview = {
  name: "Bugfix relay",
  description: "Haiku plans, Sonnet builds",
  stages: [
    stage({ instructions: "Keep the plan to five steps.\nName every file." }),
    stage({
      position: 1, label: "Implement", role: "implement", agentModel: "mystery-model-9", readOnly: false,
      tools: ["read_file", "write_file", "run_command"], unpricedModel: true, escalateModel: "claude-sonnet-4-6",
    }),
    stage({ position: 2, label: "Ship", role: "ship-2", actionRole: true, readOnly: false, tools: ["run_command"] }),
  ],
  roles: [{ key: "ship-2", originalKey: "ship", label: "Ship", promptBody: "Commit and open the PR.", fate: "renamed" }],
  problems: [],
  ok: true,
};

beforeEach(() => {
  previewMock.mockReset();
  importMock.mockReset();
  createRunMock.mockReset();
  startRunMock.mockReset();
  useCrewImportStore.getState().close();
});

describe("CrewImportSheet", () => {
  it("shows writers, tools, full instructions, role prompts and unpriced models before saving", async () => {
    previewMock.mockResolvedValue(GOOD);
    useCrewImportStore.getState().show("{crew}", "relay.octocrew.json");
    render(<CrewImportHost />);

    expect(await screen.findByText("Bugfix relay")).toBeInTheDocument();
    expect(screen.getByText(/relay\.octocrew\.json/)).toBeInTheDocument();
    expect(screen.getByText(/3 stages · 2 can change files/)).toBeInTheDocument();
    expect(screen.getAllByText("writer")).toHaveLength(2);
    expect(screen.getAllByText("read-only")).toHaveLength(1);
    expect(screen.getByText(/Keep the plan to five steps\.\s+Name every file\./)).toBeInTheDocument();
    expect(screen.getByText("may commit, push and run release commands")).toBeInTheDocument();
    expect(screen.getByText("Commit and open the PR.")).toBeInTheDocument();
    expect(screen.getByText(/saved as ship-2 · ship is taken here/)).toBeInTheDocument();
    // The unknown model is flagged, never priced as free.
    await waitFor(() => expect(screen.getByText("not in your catalog · unpriced")).toBeInTheDocument());
    expect(importMock).not.toHaveBeenCalled();
  });

  it("a CLI stage shows its full shell and dialect instead of a tool list, and the header counts it", async () => {
    previewMock.mockResolvedValue({
      ...GOOD,
      stages: [
        stage({
          label: "Builder", substrate: "cli", cliDialect: "claude", readOnly: false, tools: [],
          warnings: ["Its tool list only limits API stages. As a CLI stage it gets a full shell instead."],
        }),
        stage({ position: 1, label: "Codex", substrate: "cli", cliDialect: "codex", agentModel: "gpt-5-codex", readOnly: false, tools: [] }),
        stage({ position: 2, label: "Codex review", substrate: "cli", cliDialect: "codex", agentModel: "gpt-5-codex", readOnly: true, tools: [] }),
        stage({ position: 3, label: "Plan" }),
      ],
    });
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    expect(await screen.findByText("Full shell · Claude Code (all permissions)")).toBeInTheDocument();
    expect(screen.getByText("Full shell · Codex (workspace-write sandbox)")).toBeInTheDocument();
    expect(screen.getByText("Shell · Codex (read-only sandbox)")).toBeInTheDocument();
    expect(screen.getByText(/3 with a full shell \(CLI\)/)).toBeInTheDocument();
    expect(screen.getByTestId("crew-cli-note").textContent).toMatch(/\.claude\/settings\.json hooks and \.mcp\.json/);
    expect(screen.getByText(/tool list only limits API stages/)).toBeInTheDocument();
    // Only the API stage lists tools.
    expect(screen.getAllByTestId("crew-stage-tools")).toHaveLength(1);
    expect(screen.getAllByTestId("crew-stage-shell")).toHaveLength(3);
  });

  it("an API-only crew shows no CLI note", async () => {
    previewMock.mockResolvedValue(GOOD);
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    expect(await screen.findByText("Bugfix relay")).toBeInTheDocument();
    expect(screen.queryByTestId("crew-cli-note")).not.toBeInTheDocument();
    expect(screen.queryByText(/with a full shell/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("crew-stage-shell")).not.toBeInTheDocument();
  });

  it("substrate, escalation and loops get their own rows, never one truncated line", async () => {
    const long = "claude-opus-4-6-with-a-very-long-identifier-that-would-be-cut-off";
    previewMock.mockResolvedValue({
      ...GOOD,
      stages: [
        stage({ effort: "high", escalateModel: long, escalateEffort: "max" }),
        stage({ position: 1, label: "Review", loopTargetPosition: 0, loopMode: "auto", loopMaxIterations: 3 }),
      ],
    });
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    expect(await screen.findByText(`escalates to ${long} · effort max`)).toBeInTheDocument();
    expect(screen.getByText("Loops back to stage 1 · auto · up to ×3")).toBeInTheDocument();
    expect(screen.getByText(/claude-haiku-4-5 · effort high/)).toBeInTheDocument();
    expect(screen.getAllByTestId("crew-stage-substrate")[0].textContent).toBe("API");
    for (const id of ["crew-stage-escalation", "crew-stage-loop", "crew-stage-substrate"]) {
      for (const el of screen.getAllByTestId(id)) expect(el.className).not.toMatch(/truncate/);
    }
  });

  it("re-previews with a replacement model and imports with it, never starting a run", async () => {
    previewMock.mockResolvedValue(GOOD);
    importMock.mockResolvedValue("new-pipeline");
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    fireEvent.click(await screen.findByText("model:mystery-model-9"));
    await waitFor(() =>
      expect(previewMock).toHaveBeenLastCalledWith("{crew}", [["mystery-model-9", "claude-sonnet-4-6"]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add this crew to my library" }));
    await waitFor(() => expect(importMock).toHaveBeenCalledWith("{crew}", [["mystery-model-9", "claude-sonnet-4-6"]]));
    await waitFor(() => expect(useCrewImportStore.getState().open).toBe(false));
    expect(createRunMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("an invalid crew shows the per-stage error and cannot be added", async () => {
    previewMock.mockResolvedValue({
      ...GOOD,
      ok: false,
      problems: ["role 'odd' has an unknown tool 'teleport'"],
      stages: [
        stage({ position: 0, problem: "Stage 1 instructions are too long (max 8000 characters)" }),
        stage({ position: 1, problem: "Stage 2: unknown tool 'format_disk'" }),
      ],
    });
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    // The backend's message names the stage; the sheet doesn't add a second prefix.
    expect(await screen.findByText("Stage 1 instructions are too long (max 8000 characters)")).toBeInTheDocument();
    expect(screen.getByText("Stage 2: unknown tool 'format_disk'")).toBeInTheDocument();
    expect(screen.queryByText(/Stage \d+: Stage/i)).not.toBeInTheDocument();
    expect(screen.getByText("role 'odd' has an unknown tool 'teleport'")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add this crew to my library" })).toBeDisabled();
    expect(screen.getByText(/nothing was saved/)).toBeInTheDocument();
  });

  it("a file that isn't a crew says so and offers another try", async () => {
    previewMock.mockRejectedValue(new Error("This JSON isn't an Octopush crew (no \"octocrew\" version)."));
    useCrewImportStore.getState().show("{}", "x.json");
    render(<CrewImportHost />);
    expect(await screen.findByText(/isn't an Octopush crew/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try another crew" }));
    expect(await screen.findByLabelText("Crew JSON")).toBeInTheDocument();
  });

  it("Escape closes the sheet without importing", async () => {
    previewMock.mockResolvedValue(GOOD);
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    expect(await screen.findByText("Bugfix relay")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useCrewImportStore.getState().open).toBe(false));
    expect(screen.queryByText("Bugfix relay")).not.toBeInTheDocument();
    expect(importMock).not.toHaveBeenCalled();
  });

  it("shows the loading state while the preview is pending", async () => {
    let resolve: (p: CrewPreview) => void = () => {};
    previewMock.mockReturnValue(new Promise<CrewPreview>((r) => (resolve = r)));
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    expect(screen.getByText("Reading the crew…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add this crew to my library" })).toBeDisabled();
    resolve(GOOD);
    expect(await screen.findByText("Bugfix relay")).toBeInTheDocument();
    expect(screen.queryByText("Reading the crew…")).not.toBeInTheDocument();
  });

  it("a failed import shows its error, keeps the sheet open and re-enables the CTA", async () => {
    previewMock.mockResolvedValue(GOOD);
    importMock.mockRejectedValue(new Error("other: database is locked"));
    useCrewImportStore.getState().show("{crew}", null);
    render(<CrewImportHost />);
    const cta = await screen.findByRole("button", { name: "Add this crew to my library" });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);
    expect(await screen.findByText("database is locked")).toBeInTheDocument();
    expect(useCrewImportStore.getState().open).toBe(true);
    expect(screen.getByText("Bugfix relay")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add this crew to my library" })).toBeEnabled());
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("pasted JSON goes to the review", async () => {
    previewMock.mockResolvedValue(GOOD);
    useCrewImportStore.getState().show();
    render(<CrewImportHost />);
    fireEvent.change(screen.getByLabelText("Crew JSON"), { target: { value: " {pasted} " } });
    fireEvent.click(screen.getByRole("button", { name: "Review this crew" }));
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("{pasted}", []));
    expect(await screen.findByText("Bugfix relay")).toBeInTheDocument();
  });
});
