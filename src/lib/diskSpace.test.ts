import { describe, it, expect } from "vitest";
import { LOW_DISK_BYTES, lowDiskLine } from "./diskSpace";

const GB = 1024 ** 3;
const TOTAL = 500 * GB;

describe("lowDiskLine", () => {
  it("warns under 2 GB free with the free size", () => {
    expect(lowDiskLine({ freeBytes: 1.4 * GB, totalBytes: TOTAL })).toBe(
      "Only 1.4 GB free — this run may fail when the disk fills",
    );
    expect(lowDiskLine({ freeBytes: LOW_DISK_BYTES - 1, totalBytes: TOTAL })).not.toBeNull();
  });

  it("stays quiet at 2 GB and above", () => {
    expect(lowDiskLine({ freeBytes: LOW_DISK_BYTES, totalBytes: TOTAL })).toBeNull();
    expect(lowDiskLine({ freeBytes: 18 * GB, totalBytes: TOTAL })).toBeNull();
  });

  it("stays quiet without a reading", () => {
    expect(lowDiskLine(null)).toBeNull();
    expect(lowDiskLine(undefined)).toBeNull();
    expect(lowDiskLine({ freeBytes: 0, totalBytes: 0 })).toBeNull();
  });
});
