/** Hop-by-hop headers (RFC 9110 section 7.6.1) that a proxy must not forward. */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function withoutHopByHop(entries: Iterable<readonly [string, string]>) {
  return Array.from(entries).filter((entry) => !HOP_BY_HOP.has(entry[0].toLowerCase()))
}

export function toHeaders(entries: Iterable<readonly [string, string]>) {
  const headers = new Headers()
  for (const entry of entries) headers.append(entry[0], entry[1])
  return headers
}

/** fetch decompresses bodies but keeps their original encoding headers, which no longer describe the bytes. */
export function withoutDecodedHeaders(headers: Headers) {
  const encoded = headers.has("content-encoding")
  return Array.from(headers).filter((entry) => {
    const name = entry[0].toLowerCase()
    if (HOP_BY_HOP.has(name)) return false
    return !(encoded && (name === "content-encoding" || name === "content-length"))
  })
}
