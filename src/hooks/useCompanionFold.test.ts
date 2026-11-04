import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useCompanionFold } from "./useCompanionFold";

function setup(initialCollapsed: boolean) {
  return renderHook(
    ({ panesFold }: { panesFold: boolean }) => {
      const [collapsed, setCollapsed] = useState(initialCollapsed);
      return { fold: useCompanionFold(panesFold, collapsed, setCollapsed), choice: collapsed };
    },
    { initialProps: { panesFold: false } },
  );
}

describe("useCompanionFold", () => {
  it("follows the choice with one pane, folds while split, and restores the choice after", () => {
    const { result, rerender } = setup(false);
    act(() => result.current.fold.toggle());
    act(() => result.current.fold.toggle());
    expect(result.current.fold).toMatchObject({ collapsed: false, folded: false });
    rerender({ panesFold: true });
    expect(result.current.fold).toMatchObject({ collapsed: true, folded: true, over: false });
    rerender({ panesFold: false });
    expect(result.current.fold).toMatchObject({ collapsed: false, folded: false, over: false });
  });

  it("brings it back over the panes until the next fold, and that toggle wins", () => {
    const { result, rerender } = setup(true);
    rerender({ panesFold: true });
    act(() => result.current.fold.toggle());
    expect(result.current.fold).toMatchObject({ collapsed: false, folded: false, over: true });
    expect(result.current.choice).toBe(false);

    // Back to one pane: the toggle made while split is the choice now.
    rerender({ panesFold: false });
    expect(result.current.fold.collapsed).toBe(false);

    // The next fold folds again; a second toggle folds back and is remembered.
    rerender({ panesFold: true });
    expect(result.current.fold).toMatchObject({ collapsed: true, over: false });
    act(() => result.current.fold.toggle());
    act(() => result.current.fold.toggle());
    expect(result.current.fold).toMatchObject({ collapsed: true, folded: true, over: false });
    rerender({ panesFold: false });
    expect(result.current.fold.collapsed).toBe(true);
  });
});
