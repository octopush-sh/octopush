/**
 * The premise of the ⌘K palette's section order: cmdk 1.1 scores and sorts
 * the rows inside a section, but keeps the sections where they are drawn (its
 * section sort looks a section up by its id in `data-value`, which holds the
 * heading, and finds nothing). So `CommandPalette` decides the order of its
 * sections in its JSX. If a cmdk upgrade makes this fail, sections start
 * moving by score and the palette must pin Groups before Workspaces itself.
 */
import { it, expect } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { Command } from "cmdk";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { writable: true, configurable: true, value: ResizeObserverMock });
Element.prototype.scrollIntoView ??= () => {};

it("cmdk keeps sections in the order they are drawn, whatever their rows score", async () => {
  await act(async () => {
    render(
      <Command filter={(value) => (value.startsWith("strong") ? 1 : 0.1)}>
        <Command.Input placeholder="query" />
        <Command.List>
          <Command.Group heading="First">
            <Command.Item value="weak">weak</Command.Item>
          </Command.Group>
          <Command.Group heading="Second">
            <Command.Item value="strong">strong</Command.Item>
          </Command.Group>
        </Command.List>
      </Command>,
    );
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("query"), { target: { value: "s" } });
  });
  const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
  expect(headings).toEqual(["First", "Second"]);
});
