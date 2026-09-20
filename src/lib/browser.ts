/** True for desktop Safari and every iOS browser (all of them are WebKit). */
export function isWebKit(): boolean {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const ua = nav.userAgent ?? "";
  const platform = "platform" in nav ? String((nav as Navigator).platform ?? "") : "";
  const maxTouchPoints = "maxTouchPoints" in nav ? (nav.maxTouchPoints ?? 0) : 0;
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    /FxiOS|CriOS|EdgiOS/.test(ua) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  if (iOS) return true;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Android|Edg|Firefox|OPR/i.test(ua);
}
