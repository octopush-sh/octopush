import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { ipcMock } = vi.hoisted(() => ({ ipcMock: { openFileInSystem: vi.fn(async () => {}) } }));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));

import { ReleaseNotes, isSafeNotesHref } from "./ReleaseNotes";

beforeEach(() => vi.clearAllMocks());

describe("ReleaseNotes", () => {
  it("renders headings, lists, bold and links", () => {
    render(<ReleaseNotes markdown={"## Features\n\n- **Bold** item\n- [Docs](https://octopush.sh/docs)"} />);
    expect(screen.getByRole("heading", { name: "Features" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "Docs" });
    fireEvent.click(link);
    expect(ipcMock.openFileInSystem).toHaveBeenCalledWith("https://octopush.sh/docs");
  });

  it("drops raw HTML", () => {
    const { container } = render(
      <ReleaseNotes markdown={'Hello <script>alert(1)</script><iframe src="https://x"></iframe><b onclick="x()">raw</b>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("[onclick]")).toBeNull();
  });

  it("never loads images, remote or not", () => {
    const { container } = render(
      <ReleaseNotes markdown={"![tracker](https://evil.example/p.gif) ![local](./a.png)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("tracker")).toBeInTheDocument();
  });

  it("does not make unsafe links clickable", () => {
    render(<ReleaseNotes markdown={"[x](javascript:alert(1)) [y](file:///etc/passwd)"} />);
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByText("x"));
    expect(ipcMock.openFileInSystem).not.toHaveBeenCalled();
  });

  it("isSafeNotesHref accepts only http(s) and mailto", () => {
    expect(isSafeNotesHref("https://a.b")).toBe(true);
    expect(isSafeNotesHref("mailto:a@b.c")).toBe(true);
    expect(isSafeNotesHref("javascript:alert(1)")).toBe(false);
    expect(isSafeNotesHref("")).toBe(false);
    expect(isSafeNotesHref(undefined)).toBe(false);
  });
});
