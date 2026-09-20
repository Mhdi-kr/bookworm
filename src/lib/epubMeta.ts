import JSZip from "jszip";

export type EpubFileMeta = {
  title: string;
  authors: string[];
  isbn: string | null;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  pageCount: number | null;
  coverBlob: Blob | null;
};

const DC_NS = "http://purl.org/dc/elements/1.1/";
const OPF_NS = "http://www.idpf.org/2007/opf";
const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";

export async function readEpubMetadata(data: ArrayBuffer): Promise<EpubFileMeta> {
  const zip = await JSZip.loadAsync(data);
  const opfPath = await findOpfPath(zip);
  if (!opfPath) {
    return emptyMeta();
  }
  const opfText = await zip.file(opfPath)?.async("string");
  if (!opfText) return emptyMeta();

  const xml = new DOMParser().parseFromString(opfText, "application/xml");
  const titles = dcTexts(xml, "title");
  const authors = dcTexts(xml, "creator");
  const isbn = dcTexts(xml, "identifier").map(findIsbn).find((value) => value) ?? null;
  const coverHref = findCoverHref(xml);
  const coverBlob = coverHref ? await readCover(zip, opfPath, coverHref) : null;

  return {
    title: titles[0] ?? "",
    authors,
    isbn,
    description: dcTexts(xml, "description")[0] ?? null,
    publisher: dcTexts(xml, "publisher")[0] ?? null,
    publishedDate: dcTexts(xml, "date")[0] ?? null,
    language: dcTexts(xml, "language")[0] ?? null,
    pageCount: countSpine(xml),
    coverBlob,
  };
}

function emptyMeta(): EpubFileMeta {
  return {
    title: "",
    authors: [],
    isbn: null,
    description: null,
    publisher: null,
    publishedDate: null,
    language: null,
    pageCount: null,
    coverBlob: null,
  };
}

async function findOpfPath(zip: JSZip): Promise<string | null> {
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) return null;
  const xml = new DOMParser().parseFromString(container, "application/xml");
  const rootfiles = [
    ...Array.from(xml.getElementsByTagNameNS(CONTAINER_NS, "rootfile")),
    ...Array.from(xml.getElementsByTagName("rootfile")),
  ];
  const fullPath =
    rootfiles
      .map((node) => node.getAttribute("full-path"))
      .find((value) => value && value.trim()) ?? null;
  return fullPath ? decodeURIComponent(fullPath.trim()) : null;
}

function dcTexts(xml: Document, tag: string): string[] {
  const nodes = [
    ...Array.from(xml.getElementsByTagNameNS(DC_NS, tag)),
    ...Array.from(xml.getElementsByTagName(`dc:${tag}`)),
    ...Array.from(xml.getElementsByTagName(tag)),
  ];
  const values: string[] = [];
  const seen = new Set<Element>();
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (text) values.push(text);
  }
  return values;
}

function countSpine(xml: Document): number | null {
  const refs = [
    ...Array.from(xml.getElementsByTagNameNS(OPF_NS, "itemref")),
    ...Array.from(xml.getElementsByTagName("itemref")),
  ];
  const unique = new Set(refs);
  return unique.size > 0 ? unique.size : null;
}

function findCoverHref(xml: Document): string | null {
  const metas = [...Array.from(xml.getElementsByTagNameNS(OPF_NS, "meta")), ...Array.from(xml.getElementsByTagName("meta"))];
  const coverId = metas
    .find((meta) => (meta.getAttribute("name") || "").toLowerCase() === "cover")
    ?.getAttribute("content");

  const items = [
    ...Array.from(xml.getElementsByTagNameNS(OPF_NS, "item")),
    ...Array.from(xml.getElementsByTagName("item")),
  ];
  const byId = coverId ? items.find((item) => item.getAttribute("id") === coverId) : undefined;
  const byProperty = items.find((item) =>
    (item.getAttribute("properties") || "").split(/\s+/).includes("cover-image"),
  );
  const href = byId?.getAttribute("href") || byProperty?.getAttribute("href");
  if (href) return href;

  const refs = [
    ...Array.from(xml.getElementsByTagNameNS(OPF_NS, "reference")),
    ...Array.from(xml.getElementsByTagName("reference")),
  ];
  const guide = refs.find((node) => (node.getAttribute("type") || "").toLowerCase() === "cover");
  return guide?.getAttribute("href") ?? null;
}

async function readCover(zip: JSZip, opfPath: string, href: string): Promise<Blob | null> {
  const path = resolveZipPath(opfPath, href.split("#")[0] ?? href);
  const file = zip.file(path) ?? zip.file(decodeURIComponent(path));
  if (!file) return null;
  const bytes = await file.async("uint8array");
  if (bytes.byteLength < 1024) return null;
  const type = sniffImageType(bytes);
  if (!type) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type });
}

function resolveZipPath(opfPath: string, href: string): string {
  const cleanHref = href.replace(/^\//, "");
  const parts = opfPath.split("/").slice(0, -1);
  for (const segment of cleanHref.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function findIsbn(text: string): string | null {
  const match = text.match(/(?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx]\b/i);
  if (!match) return null;
  const compact = match[0].replace(/[^0-9X]/gi, "").toUpperCase();
  if (compact.length === 13 && /^\d{13}$/.test(compact)) return compact;
  if (compact.length === 10) return compact;
  return null;
}
