import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockListFiles, mockListSkills } = vi.hoisted(() => ({
  mockListFiles: vi.fn(),
  mockListSkills: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ipc: { listWorkspaceFiles: mockListFiles, listSkills: mockListSkills },
}));

import { RichPromptTextarea } from "./RichPromptTextarea";

const WS = "/repo/wt/feature";

beforeEach(() => {
  vi.clearAllMocks();
  mockListFiles.mockResolvedValue([
    "src/components/ReviewCanvas.tsx",
    "src/lib/modeMeta.ts",
  ]);
  mockListSkills.mockResolvedValue([
    { name: "code-review", description: "Review it", source: "project" },
    { name: "simplify", description: "Tidy it", source: "user" },
  ]);
});

/** Types into the textarea the way the component reads it: value + caret. */
function type(el: HTMLTextAreaElement, value: string) {
  fireEvent.change(el, { target: { value, selectionStart: value.length } });
}

describe("RichPromptTextarea", () => {
  it("offers worktree files after @ and inserts the picked path", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RichPromptTextarea value="" onChange={onChange} workspacePath={WS} aria-label="brief" />,
    );
    await waitFor(() => expect(mockListFiles).toHaveBeenCalledWith(WS));
    const ta = screen.getByLabelText("brief") as HTMLTextAreaElement;

    type(ta, "Refactor @modeM");
    rerender(
      <RichPromptTextarea
        value="Refactor @modeM"
        onChange={onChange}
        workspacePath={WS}
        aria-label="brief"
      />,
    );
    const option = await screen.findByText(/modeMeta\.ts/, {}, { timeout: 4000 });
    // The popovers commit on mouseDown, not click — that is what keeps the
    // textarea from blurring out from under the selection.
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("src/lib/modeMeta.ts"));
  });

  it("offers skills after / and inserts the slug the backend resolves", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RichPromptTextarea value="" onChange={onChange} workspacePath={WS} aria-label="brief" />,
    );
    await waitFor(() => expect(mockListSkills).toHaveBeenCalledWith(WS));
    const ta = screen.getByLabelText("brief") as HTMLTextAreaElement;

    // Mid-prose, not just at position 0 — a brief is prose, unlike a chat line.
    type(ta, "Ship it, then /code");
    rerender(
      <RichPromptTextarea
        value="Ship it, then /code"
        onChange={onChange}
        workspacePath={WS}
        aria-label="brief"
      />,
    );
    fireEvent.mouseDown(await screen.findByText("code-review", {}, { timeout: 4000 }));
    expect(onChange).toHaveBeenCalledWith("Ship it, then /code-review ");
  });

  it("submits on ⌘⏎ when no popover is open", async () => {
    const onSubmit = vi.fn();
    render(
      <RichPromptTextarea
        value="go"
        onChange={vi.fn()}
        workspacePath={WS}
        onSubmit={onSubmit}
        aria-label="brief"
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("brief"), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("⌘⏎ does not submit while a reference list is open — Enter picks", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    // Start EMPTY and let the change event carry the new text: firing a change
    // whose value equals the current one is suppressed by React's value
    // tracker, so `onChange` never runs and the list never opens — that was a
    // ~35% flake, not a timing quirk.
    const { rerender } = render(
      <RichPromptTextarea
        value=""
        onChange={onChange}
        workspacePath={WS}
        onSubmit={onSubmit}
        aria-label="brief"
      />,
    );
    await waitFor(() => expect(mockListSkills).toHaveBeenCalled());
    const ta = screen.getByLabelText("brief") as HTMLTextAreaElement;
    type(ta, "Ship it, then /code");
    rerender(
      <RichPromptTextarea
        value="Ship it, then /code"
        onChange={onChange}
        workspacePath={WS}
        onSubmit={onSubmit}
        aria-label="brief"
      />,
    );
    await screen.findByText("code-review", {}, { timeout: 4000 });

    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("Ship it, then /code-review ");
  });

  it("shows no menu — and no empty-state panel — for a slash in ordinary prose", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RichPromptTextarea value="" onChange={onChange} workspacePath={WS} aria-label="brief" />,
    );
    await waitFor(() => expect(mockListSkills).toHaveBeenCalled());
    const ta = screen.getByLabelText("brief") as HTMLTextAreaElement;
    type(ta, "write it to /usr");
    rerender(
      <RichPromptTextarea
        value="write it to /usr"
        onChange={onChange}
        workspacePath={WS}
        aria-label="brief"
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/No skills found/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
