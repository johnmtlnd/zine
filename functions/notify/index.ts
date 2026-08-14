// ============================================================
//  notify — Supabase Edge Function
//
//  Pushes to the OTHER person when you add something. Never to
//  yourself: an app that notifies you about your own typing is
//  a special kind of annoying.
//
//  Deploy: Supabase dashboard → Edge Functions → Deploy a new
//  function → name it "notify" → paste this in.
//  Secrets needed: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
//  See SETUP.md step 6.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { preview } = await req.json();

    const authHeader = req.headers.get("Authorization") ?? "";

    // Who's asking? Use their own token so we get their identity,
    // not the service role's.
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "unauthorised" }, 401);

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: me } = await db.from("profiles")
      .select("display_name").eq("id", user.id).single();

    // Everyone who isn't you. With two users that's one person,
    // but this doesn't break if you ever add a third.
    const { data: subs } = await db.from("push_subscriptions")
      .select("*").neq("user_id", user.id);

    if (!subs?.length) return json({ ok: true, sent: 0 });

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@example.com",
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!,
    );

    const payload = JSON.stringify({
      title: `${me?.display_name ?? "Someone"} added one`,
      body: preview ?? "",
    });

    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          payload,
        );
        sent++;
      } catch (e) {
        // 404/410 means the browser threw the subscription away.
        // Clean it up rather than retrying it forever.
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await db.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }

    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
