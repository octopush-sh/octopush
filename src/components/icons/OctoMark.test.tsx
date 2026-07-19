import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OctoMark, OctoRig } from "./OctoMark";

describe("OctoMark", () => {
  it("renders the static artwork with no animation classes", () => {
    const { container } = render(<OctoMark size={48} />);
    expect(container.querySelector(".octo-mascot")).toBeNull();
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("applies the state class on animated rigs", () => {
    const { container } = render(<OctoMark size={48} state="working" />);
    expect(container.querySelector("svg.octo-mascot.octo-mascot--working")).not.toBeNull();
  });

  it("hides the back-arm row below 20px and shows it at 20px+", () => {
    const { container: small } = render(<OctoMark size={16} state="idle" />);
    expect(small.querySelector(".octo-m-b1")).toBeNull();
    const { container: big } = render(<OctoMark size={20} state="idle" />);
    expect(big.querySelector(".octo-m-b1")).not.toBeNull();
  });

  it("renders the halo ring only in the pushed state", () => {
    const { container: pushed } = render(<OctoMark size={48} state="pushed" />);
    expect(pushed.querySelector(".octo-m-ring")).not.toBeNull();
    const { container: idle } = render(<OctoMark size={48} state="idle" />);
    expect(idle.querySelector(".octo-m-ring")).toBeNull();
  });

  it("is decorative by default (aria-hidden)", () => {
    const { container } = render(<OctoMark />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("OctoRig", () => {
  it("renders the bare rig (arms + eyes group) without an svg wrapper", () => {
    const { container } = render(
      <svg viewBox="0 0 64 66"><OctoRig eyeR={3.6} showBack={false} /></svg>,
    );
    expect(container.querySelector(".octo-m-eyes")).not.toBeNull();
    expect(container.querySelector(".octo-m-f1")).not.toBeNull();
    expect(container.querySelector(".octo-m-b1")).toBeNull();
    expect(container.querySelectorAll("svg").length).toBe(1);
  });
});
