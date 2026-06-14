import { describe, it, expect } from "vitest";
import { fileToAttachment, attachmentDataUrl } from "./attachments";

describe("attachmentDataUrl", () => {
  it("builds a base64 data URL from media type + data", () => {
    expect(attachmentDataUrl({ mediaType: "image/png", data: "QUJD", name: "a.png" })).toBe(
      "data:image/png;base64,QUJD",
    );
  });
});

describe("fileToAttachment", () => {
  it("rejects non-image files", async () => {
    const txt = new File(["hello"], "notes.txt", { type: "text/plain" });
    expect(await fileToAttachment(txt)).toBeNull();
  });

  it("converts an image File into a base64 attachment", async () => {
    // "ABC" → base64 "QUJD"
    const img = new File(["ABC"], "pic.png", { type: "image/png" });
    const att = await fileToAttachment(img);
    expect(att).not.toBeNull();
    expect(att!.mediaType).toBe("image/png");
    expect(att!.name).toBe("pic.png");
    expect(att!.data).toBe("QUJD");
  });
});
