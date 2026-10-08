/**
 * Media URL handling for the chat cards, kept free of React so it can be
 * unit-tested from node. Since 0.6.0 every URL the host hands out is a
 * same-origin path, preferring the local archive copy.
 */

/**
 * Same-origin path of a media URL. Cards written before 0.6.0 stored
 * absolute URLs (LAN IP or 127.0.0.1 with whatever port DSH had then); only
 * the path + query matter, and the media route itself prefers the local
 * archive, so the old card keeps playing on today's origin.
 */
export function sameOriginPath(url: string): string {
  if (url.startsWith('/')) return url
  try {
    const parsed = new URL(url)
    if (parsed.pathname.startsWith('/comfyui/')) return `${parsed.pathname}${parsed.search}`
  } catch {
    // Not a URL (headless hosts stored bare file names): leave it.
  }
  return url
}

/** URLs to try in order: the preferred one (local archive when archived), then the proxy. */
export function mediaSources(item: { url: string; proxyUrl?: string }): string[] {
  const sources = [sameOriginPath(item.url)]
  if (item.proxyUrl !== undefined) {
    const proxy = sameOriginPath(item.proxyUrl)
    if (!sources.includes(proxy)) sources.push(proxy)
  }
  return sources
}

