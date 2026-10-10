// Fray: send-due-pushes
// Called every 30 seconds by pg_cron (see supabase/push-schedule.sql).
//  1. Timers that just ran out -> "Time's up for <task>!" to the owner's devices
//     (if they have timer alerts on).
//  2. 9pm local time -> "Setup tasks for tomorrow!" (once a day, skipped when
//     tomorrow already has tasks or the nudge is off).
// Works while Fray is closed.
//
// Secrets (Dashboard > Edge Functions > Secrets): VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// Deploy with "Verify JWT" turned OFF; the cron secret protects it instead.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const STALE_MS = 30 * 60 * 1000; // don't buzz for timers that ended over 30 min ago

// A bad secret shows up as a readable error (in net._http_response)
// instead of crashing the function on start.
const env = (k: string) => (Deno.env.get(k) ?? "").trim().replace(/^["']|["']$/g, "");
let vapidError = "";
try {
  webpush.setVapidDetails(env("VAPID_SUBJECT"), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
} catch (err) {
  vapidError = `VAPID secrets look wrong: ${(err as Error).message}`;
}

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string };
type Message = { userId: string; title: string; body: string; tag: string; url: string };

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  if (vapidError) return json({ error: vapidError }, 500);
  try {
    return await run();
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});

async function run() {

  const now = new Date();
  const messages: Message[] = [];

  // ---- 1. Timers: claim due tasks in one UPDATE so runs never double-send.
  const { data: due, error } = await db
    .from("tasks")
    .update({ push_sent_at: now.toISOString() })
    .lte("deadline_at", now.toISOString())
    .eq("completed", false)
    .is("push_sent_at", null)
    .select("id, title, user_id, deadline_at");
  if (error) return json({ error: error.message }, 500);

  const fresh = (due ?? []).filter((t) => now.getTime() - Date.parse(t.deadline_at) < STALE_MS);
  if (fresh.length) {
    const { data: prefs } = await db
      .from("profiles")
      .select("id, timer_alerts")
      .in("id", [...new Set(fresh.map((t) => t.user_id))]);
    const muted = new Set((prefs ?? []).filter((p) => p.timer_alerts === false).map((p) => p.id));
    for (const t of fresh) {
      if (muted.has(t.user_id)) continue;
      messages.push({
        userId: t.user_id,
        title: "Fray ⏰",
        body: `Time's up for ${t.title}!`,
        tag: t.id, // same tag as the in-app alert, so the phone shows one
        url: "./",
      });
    }
  }

  // ---- 2. 9pm nudge (the SQL function handles time zones and once-a-day).
  const { data: nudges, error: nudgeErr } = await db.rpc("claim_due_nudges");
  if (nudgeErr) console.error("nudge claim failed", nudgeErr.message);
  for (const n of nudges ?? []) {
    messages.push({
      userId: n.user_id,
      title: "Fray 🌙",
      body: "Setup tasks for tomorrow!",
      tag: `nudge-${now.toISOString().slice(0, 10)}`,
      url: "./?new=tomorrow",
    });
  }

  if (!messages.length) return json({ timers: fresh.length, nudges: 0, sent: 0 });

  const { data: subs, error: subErr } = await db
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth")
    .in("user_id", [...new Set(messages.map((m) => m.userId))]);
  if (subErr) return json({ error: subErr.message }, 500);

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(messages.flatMap((m) =>
    ((subs ?? []) as Sub[]).filter((s) => s.user_id === m.userId).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: m.url }),
          { TTL: 600, urgency: "high" },
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint); // device unsubscribed
        else console.error("push failed", code, (err as Error).message);
      }
    })
  ));

  if (dead.length) await db.from("push_subscriptions").delete().in("endpoint", dead);

  return json({ timers: fresh.length, nudges: nudges?.length ?? 0, sent, removed: dead.length });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
