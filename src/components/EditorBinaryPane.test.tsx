import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const revealInFinder = vi.fn();
const openFileInSystem = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    revealInFinder: (...a: unknown[]) => revealInFinder(...a),
    openFileInSystem: (...a: unknown[]) => openFileInSystem(...a),
  },
}));

import { EditorBinaryPane } from "./EditorBinaryPane";

beforeEach(() => vi.clearAllMocks());

describe("EditorBinaryPane", () => {
  it("shows the file name, size and a binary message", () => {
    render(<EditorBinaryPane path="/repo/app.war" size={2 * 1024 * 1024} reason="binary" />);
    expect(screen.getByText("app.war")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    expect(screen.getByText(/can't be edited as text/i)).toBeInTheDocument();
  });

  it("shows an encoding message for unsupportedEncoding", () => {
    render(<EditorBinaryPane path="/repo/x.dat" size={10} reason="unsupportedEncoding" />);
    expect(screen.getByText(/unsupported text encoding/i)).toBeInTheDocument();
  });

  it("reveals in Finder and opens in system with the path", async () => {
    render(<EditorBinaryPane path="/repo/app.war" size={10} reason="binary" />);
    await userEvent.click(screen.getByRole("button", { name: /reveal in finder/i }));
    expect(revealInFinder).toHaveBeenCalledWith("/repo/app.war");
    await userEvent.click(screen.getByRole("button", { name: /open in system/i }));
    expect(openFileInSystem).toHaveBeenCalledWith("/repo/app.war");
  });
});
