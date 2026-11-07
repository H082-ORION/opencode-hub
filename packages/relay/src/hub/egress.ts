import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { networkInterfaces } from "node:os"

export * as Egress from "./egress.js"

/**
 * The network guard for every request the hub sends on a user's behalf to an address that user chose: MCP connectors,
 * their OAuth metadata, registration and token endpoints (specs/remote-machines.md, "MCP proxy").
 *
 * - Always refused: the hub itself (its public host and every machine host under it, and its own port on any local
 *   address), link-local addresses (169.254.0.0/16, fe80::/10, where cloud metadata services live, and the known
 *   metadata addresses outside them), unspecified, multicast, broadcast, reserved and documentation ranges, and
 *   addresses that embed an IPv4 address (NAT64, 6to4, Teredo), which would hide what they reach.
 * - Private addresses (loopback, RFC 1918, CGNAT, unique local IPv6, benchmarking): refused unless the hub runs with
 *   `privateNetworks`, for connectors on its own network.
 * - Plain HTTP only reaches private addresses (so it needs `privateNetworks`): a public connector is HTTPS, since the
 *   hub sends it the user's secrets.
 * - Checked when a connector is saved and again before each request, on every address the name resolves to. The
 *   request then goes to the address that was checked (HTTPS still verifies the certificate against the name), so a
 *   name that resolves elsewhere a moment later (DNS rebinding) cannot redirect it. Redirects are never followed.
 */

export type Options = {
  /** Lets connectors reach private and loopback addresses, and use plain HTTP there. */
  privateNetworks?: boolean
}

/** A refused destination, with a message that can be shown to the user. */
export class RefusedError extends Error {}

type Kind = "public" | "private" | "blocked"

const blocked = new BlockList()
;[
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  // Alibaba Cloud's metadata service sits inside the CGNAT range.
  ["100.100.100.200", 32],
].forEach((entry) => blocked.addSubnet(entry[0] as string, entry[1] as number, "ipv4"))
;[
  ["::", 128],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  // AWS's IPv6 metadata service sits inside the unique local range.
  ["fd00:ec2::254", 128],
].forEach((entry) => blocked.addSubnet(entry[0] as string, entry[1] as number, "ipv6"))

const internal = new BlockList()
;[
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
].forEach((entry) => internal.addSubnet(entry[0] as string, entry[1] as number, "ipv4"))
;[
  ["::1", 128],
  ["fc00::", 7],
].forEach((entry) => internal.addSubnet(entry[0] as string, entry[1] as number, "ipv6"))

const loopback = new BlockList()
loopback.addSubnet("127.0.0.0", 8, "ipv4")
loopback.addAddress("::1", "ipv6")

/** Classifies one IP address; IPv4-mapped IPv6 addresses are classified as the IPv4 address they carry. */
export function classify(address: string): Kind {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4"
  if (isIP(address) === 0) return "blocked"
  if (blocked.check(address, family)) return "blocked"
  if (internal.check(address, family)) return "private"
  return "public"
}

export function create(input: {
  options?: Options
  /** The hub's public host name, which also covers every machine host under it. */
  hostname: string
  /** Where the hub listens, so it never calls itself. */
  listen: { hostname: string; port: number }
}) {
  const privateNetworks = input.options?.privateNetworks === true
  const hubName = input.hostname.toLowerCase().replace(/^\[|\]$/g, "")

  /**
   * Checks a destination and returns the address to connect to; throws `RefusedError` with the reason otherwise.
   * Every address the name resolves to must pass.
   */
  async function check(url: URL) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new RefusedError("Use an http(s) URL.")
    if (url.username || url.password) throw new RefusedError("The URL must not contain a user name or password.")
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (hostname === hubName || hostname.endsWith(`.${hubName}`))
      throw new RefusedError("A connector cannot point at the hub or its machines.")
    const addresses = isIP(hostname)
      ? [hostname]
      : await lookup(hostname, { all: true, verbatim: true }).then(
          (found) => found.map((entry) => entry.address),
          () => [],
        )
    if (addresses.length === 0) throw new RefusedError(`Cannot resolve ${hostname}.`)
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    addresses.forEach((address) => {
      const kind = classify(address)
      if (kind === "blocked" || isHub(address, port))
        throw new RefusedError(`${hostname} resolves to ${address}, which connectors may not reach.`)
      if (kind === "private" && !privateNetworks)
        throw new RefusedError(
          `${hostname} resolves to the private address ${address}; the hub only reaches private networks when started with --mcp-private-network.`,
        )
      if (kind === "public" && url.protocol === "http:")
        throw new RefusedError("Use https:// for a connector on a public address: the hub sends it your secrets.")
    })
    return addresses[0]!
  }

  /** The hub's own port on a loopback, unspecified, listening or local interface address. */
  function isHub(address: string, port: number) {
    if (port !== input.listen.port) return false
    const local = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address)
    const own = new Set([input.listen.hostname, "0.0.0.0", "::", ...local].map(normalize))
    return own.has(normalize(address)) || loopback.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")
  }

  return {
    privateNetworks,
    check,

    /**
     * Whether a URL the browser will visit (an OAuth authorization page) has an acceptable scheme: HTTPS, or HTTP when
     * private networks are allowed. The hub never calls it, so no address check applies.
     */
    browsable(url: URL) {
      return url.protocol === "https:" || (url.protocol === "http:" && privateNetworks)
    },

    /**
     * `fetch` to a checked destination, connecting to the address that was checked and never following a redirect.
     * Throws `RefusedError` for a refused destination.
     */
    async fetch(target: string | URL, init: RequestInit = {}) {
      const url = new URL(target)
      const address = await check(url)
      const pinned = new URL(url)
      pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
      const headers = new Headers(init.headers)
      headers.set("host", url.host)
      return fetch(pinned, {
        ...init,
        headers,
        redirect: "manual",
        // The certificate is still checked against the name, not the address.
        ...(url.protocol === "https:" ? { tls: { serverName: url.hostname.replace(/^\[|\]$/g, "") } } : {}),
      })
    },
  }
}

export type Instance = ReturnType<typeof create>

function normalize(address: string) {
  return address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "")
}
