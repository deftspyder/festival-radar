// Festival Radar alerts sender, run every 5 minutes by pg_cron (header x-cron-secret).
// 1. Presale alerts: for each festival whose confirmed sale time (next_sale in festivals.json) is within
//    24 hours or 15 minutes, a push to every member who hearted it or marked it Going or Maybe, on devices
//    with presale alerts on; once per member, festival, kind and sale time (alert_log).
// 2. Crew pings: when someone marks Going (noted in crew_events by a trigger on picks), a bundled push to
//    crewmates who hearted that festival or marked it Going or Maybe, on devices with crew pings on; at most
//    one per person, festival and day (crew_ping_log), e.g. "Sam and Ana are going to Coachella 2027".
// 3. Chat pushes: new messages in crew chats, festival threads a member follows, and direct messages, bundled into one push
//    per member and thread at most every 10 minutes (chat_ping_plan / chat_notified), on devices with crew
//    pings on. Public threads don't push. Each run also copies festival end dates into fest_dates, which
//    closes public festival chats 30 days after a festival ends.
// ?dry=1 returns the plan without sending. ?mode=test (with a member's sign-in token) sends a test alert
// to that member's own devices.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SITE = "https://deftspyder.github.io/festival-radar/";
const TZ = "America/Los_Angeles"; // crews are SoCal for now; sale times show in Pacific time
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; presale: boolean; crew_pings: boolean };
type Fest = Record<string, string>;
let cfg: { vapid_public: string; vapid_private: string; cron_secret: string } | null = null;
async function config() {
  if (!cfg) {
    const { data, error } = await sb.rpc("push_config");
    if (error || !data || !data.vapid_private) throw new Error("push config missing");
    cfg = data;
    webpush.setVapidDetails(SITE, data.vapid_public, data.vapid_private);
  }
  return cfg!;
}
// Only the site itself may call this from a browser (the test alert button).
const CORS = { "Access-Control-Allow-Origin": "https://deftspyder.github.io", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } });
const SUB_COLS = "id,user_id,endpoint,p256dh,auth,presale,crew_pings";

// Sale times without a timezone are read as Pacific time.
function parseSale(s: string): number {
  if (!s) return NaN;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const guess = Date.parse(s + "Z");
  if (!isFinite(guess)) return NaN;
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find(p => p.type === "timeZoneName")?.value || "GMT-8";
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/); const hrs = m ? Number(m[1]) : -8; const mins = m && m[2] ? Number(m[2]) : 0;
  return guess - (hrs * 60 + Math.sign(hrs || 1) * mins) * 60000;
}
const when = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";
const todayPT = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const cardUrl = (id: string) => SITE + "?card=" + encodeURIComponent(id) + "#festivals";

async function send(sub: Sub, payload: unknown): Promise<"ok" | "gone" | string> {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
    await sb.from("push_subs").update({ last_ok_at: new Date().toISOString() }).eq("id", sub.id);
    return "ok";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) { await sb.from("push_subs").delete().eq("id", sub.id); return "gone"; }
    return "error " + (code || (e as Error).message);
  }
}
async function subsFor(users: string[]) {
  const m = new Map<string, Sub[]>();
  if (!users.length) return m;
  const { data } = await sb.from("push_subs").select(SUB_COLS).in("user_id", users);
  for (const s of (data || []) as Sub[]) { if (!m.has(s.user_id)) m.set(s.user_id, []); m.get(s.user_id)!.push(s); }
  return m;
}
const delivered = (r: string[]) => r.length > 0 && (r.some(x => x === "ok") || r.every(x => x === "gone"));

async function presaleAlerts(fests: Fest[], dry: boolean) {
  const now = Date.now();
  const due: { f: Fest; sale: number; kind: "24h" | "15m"; left: number }[] = [];
  for (const f of fests) {
    if (!f || !f.id || !f.next_sale) continue;
    const sale = parseSale(String(f.next_sale)); if (!isFinite(sale) || sale <= now) continue;
    const left = sale - now;
    const kind = left <= 15 * 60e3 ? "15m" : left <= 24 * 3600e3 ? "24h" : null;
    if (kind) due.push({ f, sale, kind, left });
  }
  if (!due.length) return { due: 0 };
  const ids = due.map(d => d.f.id);
  const [{ data: hearts }, { data: picked }, { data: logs }] = await Promise.all([
    sb.from("hearts").select("user_id,festival_id").in("festival_id", ids),
    sb.from("picks").select("user_id,festival_id").in("choice", ["going", "maybe"]).in("festival_id", ids),
    sb.from("alert_log").select("user_id,festival_id,kind,sale_at").in("festival_id", ids)
  ]);
  const fans = new Map<string, Set<string>>();
  for (const r of [...(hearts || []), ...(picked || [])]) { if (!fans.has(r.festival_id)) fans.set(r.festival_id, new Set()); fans.get(r.festival_id)!.add(r.user_id); }
  const subsBy = await subsFor([...new Set([...fans.values()].flatMap(s => [...s]))]);
  const sent = new Set((logs || []).map(l => [l.user_id, l.festival_id, l.kind, new Date(l.sale_at).getTime()].join("|")));
  const plan: { uid: string; d: typeof due[number]; subs: Sub[] }[] = [];
  for (const d of due) for (const uid of fans.get(d.f.id) || []) {
    const subs = (subsBy.get(uid) || []).filter(s => s.presale);
    if (!subs.length || sent.has([uid, d.f.id, d.kind, d.sale].join("|"))) continue;
    plan.push({ uid, d, subs });
  }
  if (dry) return { due: due.length, plan: plan.map(p => ({ user: p.uid, id: p.d.f.id, kind: p.d.kind, devices: p.subs.length })) };
  let ok = 0, failed = 0;
  for (const { uid, d, subs } of plan) {
    const name = d.f.festival || d.f.id;
    const mins = Math.max(1, Math.round(d.left / 60e3)), hrs = Math.max(1, Math.round(d.left / 3600e3));
    const title = d.kind === "15m" ? `${name}: tickets in ${mins} min` : `${name}: tickets ${hrs >= 23 ? "in 24 hours" : "in " + hrs + (hrs === 1 ? " hour" : " hours")}`;
    const body = `On sale ${when(d.sale)}.` + (d.f.next_sale_label ? " " + d.f.next_sale_label : "") + (d.f.price_from ? " From " + d.f.price_from + "." : "");
    // Tap goes to tickets through the site's forwarding page (affiliate-ready); "View" opens the festival card.
    const payload = { title, body, url: SITE + "go.html?f=" + encodeURIComponent(d.f.id), view: cardUrl(d.f.id), tag: d.f.id + "-" + d.kind };
    const results = await Promise.all(subs.map(s => send(s, payload)));
    if (delivered(results)) { await sb.from("alert_log").insert({ user_id: uid, festival_id: d.f.id, kind: d.kind, sale_at: new Date(d.sale).toISOString() }); ok++; }
    else failed++;
  }
  return { due: due.length, alerts: ok, failed };
}

const names = (a: string[]) => a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} and ${a[1]}` : a.length === 3 ? `${a[0]}, ${a[1]} and ${a[2]}` : `${a[0]}, ${a[1]} and ${a.length - 2} others`;
async function crewPings(fests: Fest[], dry: boolean) {
  const cutoff = new Date(Date.now() - 60e3).toISOString();
  const { data: top } = await sb.from("crew_events").select("id").is("processed_at", null).lt("created_at", cutoff).order("id", { ascending: false }).limit(1);
  if (!top || !top.length) return { pending: 0 };
  const upto = top[0].id as number;
  const { data: rows, error } = await sb.rpc("crew_ping_plan");
  if (error) return { error: error.message };
  const day = todayPT();
  const recips = [...new Set((rows || []).map((r: { recipient: string }) => r.recipient))];
  const subsBy = await subsFor(recips);
  const { data: logs } = recips.length ? await sb.from("crew_ping_log").select("user_id,festival_id").eq("day", day).in("user_id", recips) : { data: [] };
  const done = new Set((logs || []).map(l => l.user_id + "|" + l.festival_id));
  const plan = (rows || []).map((r: { recipient: string; festival_id: string; actors: string[] }) => ({ ...r, subs: (subsBy.get(r.recipient) || []).filter(s => s.crew_pings) }))
    .filter(r => r.subs.length && !done.has(r.recipient + "|" + r.festival_id));
  if (dry) return { pending: true, upto, plan: plan.map(p => ({ user: p.recipient, id: p.festival_id, actors: p.actors, devices: p.subs.length })) };
  let ok = 0;
  for (const p of plan) {
    const f = fests.find(x => x && x.id === p.festival_id);
    const fname = f ? f.festival : p.festival_id;
    const who = names([...p.actors].sort());
    const payload = { title: `${who} ${p.actors.length === 1 ? "is" : "are"} going to ${fname}`, body: "Tap to see who's going and plan together.", url: cardUrl(p.festival_id), tag: "crew-" + p.festival_id };
    const results = await Promise.all(p.subs.map(s => send(s, payload)));
    if (delivered(results)) { await sb.from("crew_ping_log").upsert({ user_id: p.recipient, festival_id: p.festival_id, day }, { onConflict: "user_id,festival_id,day", ignoreDuplicates: true }); ok++; }
  }
  await sb.rpc("crew_events_done", { upto });
  return { pings: ok };
}

async function chatPings(fests: Fest[], dry: boolean) {
  const { data: rows, error } = await sb.rpc("chat_ping_plan");
  if (error) return { error: error.message };
  const plan = (rows || []) as { recipient: string; thread: string; crew_id: string; festival_id: string | null; crew_name: string; authors: string[]; n: number; upto: number }[];
  if (!plan.length) return { pending: 0 };
  const subsBy = await subsFor([...new Set(plan.map(p => p.recipient))]);
  const todo = plan.map(p => ({ ...p, subs: (subsBy.get(p.recipient) || []).filter(s => s.crew_pings) }));
  if (dry) return { plan: todo.map(p => ({ user: p.recipient, thread: p.thread, n: p.n, devices: p.subs.length })) };
  let ok = 0;
  for (const p of todo) {
    if (p.subs.length) {
      const f = p.festival_id ? fests.find(x => x && x.id === p.festival_id) : null;
      const dm = p.thread.startsWith("d:");
      const who = names([...p.authors].sort());
      const where = dm ? who : p.festival_id ? `${f ? f.festival : p.festival_id} · ${p.crew_name}` : `${p.crew_name} chat`;
      const n = Number(p.n);
      const count = n === 1 ? "1 new message" : n + " new messages";
      const url = SITE + "?chat=" + encodeURIComponent(p.thread) + (dm ? "#radar" : p.festival_id ? "#festivals" : "#crew");
      const results = await Promise.all(p.subs.map(s => send(s, { title: where, body: dm ? count : `${who}: ${count}`, url, tag: "chat-" + p.thread })));
      if (results.some(r => r === "ok")) ok++;
    }
    // mark as told even with no devices, so a member who turns alerts on later isn't flooded
    await sb.rpc("chat_notified", { p_user: p.recipient, p_thread: p.thread, p_upto: p.upto });
  }
  return { chats: ok };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const c = await config();

    if (url.searchParams.get("mode") === "test") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error } = await sb.auth.getUser(token);
      if (error || !u?.user) return json({ error: "not signed in" }, 401);
      const { data: subs } = await sb.from("push_subs").select(SUB_COLS).eq("user_id", u.user.id);
      const results = await Promise.all((subs || []).map(s => send(s as Sub, { title: "Festival Radar alerts are on", body: "You'll get a heads-up before tickets go on sale for your festivals, and when your crew is going.", url: SITE + "#radar", tag: "fr-test" })));
      return json({ devices: results.length, sent: results.filter(r => r === "ok").length, results });
    }

    if (req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "forbidden" }, 403);
    const dry = url.searchParams.get("dry") === "1";
    const res = await fetch(SITE + "festivals.json?t=" + Date.now(), { headers: { "Cache-Control": "no-cache" } });
    const fests: Fest[] = res.ok ? ((await res.json()).festivals || []) : [];
    const presale = res.ok ? await presaleAlerts(fests, dry) : { error: "festivals.json " + res.status };
    const crew = await crewPings(fests, dry);
    if (res.ok && !dry && fests.length) await sb.rpc("sync_fest_dates", { p: fests.filter(f => f && f.id).map(f => ({ id: f.id, festival: f.festival || "", end: f.end || "" })) });
    const chat = await chatPings(fests, dry);
    return json({ checked: fests.length, presale, crew, chat });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
