import { describe, it, expect } from "vitest";
import { File, FileArchive, FileCode, FileCog, FileJson, FileLock } from "lucide-react";
import { fileIcon } from "./fileIcons";

describe("fileIcon", () => {
  it("maps code extensions", () => {
    expect(fileIcon("Main.java")).toBe(FileCode);
    expect(fileIcon("app.tsx")).toBe(FileCode);
  });

  it("maps archives including .war", () => {
    expect(fileIcon("app.war")).toBe(FileArchive);
    expect(fileIcon("bundle.tar.gz")).toBe(FileArchive);
  });

  it("maps data files case-insensitively", () => {
    expect(fileIcon("config.YAML")).toBe(FileJson);
    expect(fileIcon("package.json")).toBe(FileJson);
  });

  it("maps dotfile configs", () => {
    expect(fileIcon(".gitignore")).toBe(FileCog);
  });

  it("maps lockfiles by full name", () => {
    expect(fileIcon("Cargo.lock")).toBe(FileLock);
    expect(fileIcon("package-lock.json")).toBe(FileLock);
    expect(fileIcon("Gemfile.lock")).toBe(FileLock);
  });

  it("falls back to the generic File icon", () => {
    expect(fileIcon("unknown.xyz")).toBe(File);
    expect(fileIcon("LICENSE")).toBe(File);
  });
});
