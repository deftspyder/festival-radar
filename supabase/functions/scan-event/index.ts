// scan-event: reads a public event page a signed-in member pasted and returns what it says about the event
// (name, dates, venue, city, picture, ticket link, lineup), from the page's schema.org Event data or its
// Open Graph tags. Nothing is saved here; the member reviews the fields, and an admin approves before anything goes live.
// verify_jwt is on, so only signed-in members can call it. Only https pages on public hostnames are fetched.

const ORIGINS = ["https://deftspyder.github.io"];
const MAX_BYTES = 2_000_000;

const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null;
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // no raw IP addresses
  if (u.port && u.port !== "443") return null;
  return u;
}

async function fetchPage(start: URL): Promise<{ html: string; url: string } | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "FestivalRadarBot/1.0 (event link preview)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location"); await res.body?.cancel();
      const n = next ? safeUrl(new URL(next, url).toString()) : null;
      if (!n) return null; url = n; continue;
    }
    if (!res.ok) { await res.body?.cancel(); return null; }
    const reader = res.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; chunks.push(value);
      if (size > MAX_BYTES) { await reader.cancel(); break; }
    }
    const buf = new Uint8Array(size); let off = 0; for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; if (off >= size) break; }
    return { html: new TextDecoder().decode(buf), url: url.toString() };
  }
  return null;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const clip = (s: unknown, n: number) => (typeof s === "string" ? decode(s).replace(/\s+/g, " ").trim().slice(0, n) : "");

function meta(html: string, key: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0]; if (!tag) return "";
  return clip(tag.match(/content=["']([^"']*)["']/i)?.[1] || "", 300);
}

function isEvent(o: Record<string, unknown>): boolean {
  const t = o["@type"]; const types = Array.isArray(t) ? t : [t];
  return types.some(x => typeof x === "string" && /Event$|^Festival$/i.test(x));
}
function findEvent(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findEvent(n, depth + 1); if (f) return f; } return null; }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (isEvent(o)) return o;
    for (const k of ["@graph", "mainEntity", "subEvent", "itemListElement", "item"]) { const f = findEvent(o[k], depth + 1); if (f) return f; }
  }
  return null;
}
const day = (s: unknown) => { const m = typeof s === "string" ? s.match(/^(\d{4}-\d{2}-\d{2})/) : null; return m ? m[1] : ""; };
const https = (s: unknown) => (typeof s === "string" && /^https:\/\//i.test(s) ? s.slice(0, 300) : "");

function parse(html: string, pageUrl: string) {
  let ev: Record<string, unknown> | null = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { ev = findEvent(JSON.parse(m[1].trim())); } catch { /* skip bad blocks */ }
    if (ev) break;
  }
  const out: Record<string, string> = { source: ev ? "event data" : "page preview" };
  if (ev) {
    out.name = clip(ev.name, 120);
    out.start = day(ev.startDate); out.end = day(ev.endDate);
    const loc = (Array.isArray(ev.location) ? ev.location[0] : ev.location) as Record<string, unknown> | undefined;
    if (loc && typeof loc === "object") {
      out.venue = clip(loc.name, 120);
      const a = loc.address as Record<string, unknown> | string | undefined;
      if (a && typeof a === "object") {
        const city = clip(a.addressLocality, 60), region = clip(a.addressRegion, 40), country = clip(typeof a.addressCountry === "object" ? (a.addressCountry as Record<string, unknown>)?.name : a.addressCountry, 40);
        out.city = [city, region || (country && !/^(US|USA|United States)$/i.test(country) ? country : "")].filter(Boolean).join(", ");
      } else if (typeof a === "string") out.city = clip(a, 80);
    }
    const img = Array.isArray(ev.image) ? ev.image[0] : ev.image;
    out.image = https(typeof img === "object" && img ? (img as Record<string, unknown>).url : img);
    const offers = (Array.isArray(ev.offers) ? ev.offers[0] : ev.offers) as Record<string, unknown> | undefined;
    out.ticket_link = https(offers && offers.url) || "";
    const perf = (Array.isArray(ev.performer) ? ev.performer : ev.performer ? [ev.performer] : []) as unknown[];
    out.lineup = perf.map(p => clip(typeof p === "object" && p ? (p as Record<string, unknown>).name : p, 60)).filter(Boolean).slice(0, 40).join(", ");
  }
  out.name ||= meta(html, "og:title") || clip(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "", 120);
  out.image ||= https(meta(html, "og:image"));
  out.description = meta(html, "og:description") || meta(html, "description");
  out.url = pageUrl;
  if (!out.ticket_link) out.ticket_link = pageUrl;
  return out;
}

Deno.serve(async req => {
  const h = { ...cors(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: h });
  // Signed-in members only: the gateway has verified the token, so read its role (the anon key alone is not enough).
  const role = (() => {
    try {
      const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").split(".")[1] || "";
      const b = t.replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(atob(b + "=".repeat((4 - b.length % 4) % 4))).role || "";
    } catch { return ""; }
  })();
  if (role !== "authenticated") return new Response(JSON.stringify({ error: "Sign in to scan links." }), { status: 401, headers: h });
  try {
    const { url } = await req.json().catch(() => ({ url: "" }));
    const u = safeUrl(url);
    if (!u) return new Response(JSON.stringify({ error: "Paste a full https:// link to the event page." }), { status: 400, headers: h });
    const page = await fetchPage(u);
    if (!page) return new Response(JSON.stringify({ error: "Couldn't read that page. You can fill in the details yourself." }), { status: 200, headers: h });
    return new Response(JSON.stringify({ ok: true, event: parse(page.html, page.url) }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Couldn't read that page. You can fill in the details yourself." }), { status: 200, headers: h });
  }
});
