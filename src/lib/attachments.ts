import type { Attachment } from "./types";

/** Image media types accepted as chat attachments (matches the backend). */
export const ATTACHMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** Max attachment size — must match the backend's 5 MB cap. */
export const ATTACHMENT_MAX_BYTES = 5_000_000;

/**
 * Convert a pasted/dropped browser `File` (image) into a base64 `Attachment`,
 * or return null when it's not a supported image or exceeds the size cap.
 * Used for clipboard paste and drag-drop (the file-picker path reads via the
 * backend `read_attachment` command instead).
 */
const EXT_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The image media type for a File — prefers the browser-sniffed `file.type`,
 *  falling back to the filename extension (some drag/clipboard sources hand us
 *  an empty type even for valid images). Returns null when unsupported. */
function imageMediaType(file: File): string | null {
  if (ATTACHMENT_IMAGE_TYPES.includes(file.type)) return file.type;
  const ext = (file.name.toLowerCase().split(".").pop() ?? "");
  return EXT_MEDIA_TYPE[ext] ?? null;
}

export async function fileToAttachment(file: File): Promise<Attachment | null> {
  const mediaType = imageMediaType(file);
  if (!mediaType) return null;
  if (file.size > ATTACHMENT_MAX_BYTES) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  return {
    mediaType,
    data: dataUrl.slice(comma + 1),
    name: file.name || "pasted-image",
  };
}

/** A `data:` URL for previewing an attachment as an <img> thumbnail. */
export function attachmentDataUrl(a: Attachment): string {
  return `data:${a.mediaType};base64,${a.data}`;
}
