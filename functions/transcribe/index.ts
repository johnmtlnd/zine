// ============================================================
//  transcribe — Supabase Edge Function
//
//  Runs after an audio file lands. Never blocks capture: the
//  entry already exists with its words (or with none), and this
//  fills in the transcript whenever it gets around to it.
//
//  Deploy: Supabase dashboard → Edge Functions → Deploy a new
//  function → name it "transcribe" → paste this in.
//  Then set the OPENAI_API_KEY secret. See SETUP.md step 5.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const { entry_id, audio_path } = await req.json();
    if (!entry_id || !audio_path) {
      return json({ error: "entry_id and audio_path required" }, 400);
    }

    // Service role: this function is the only thing that writes
    // transcripts, and it needs to read a private bucket.
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: file, error: dlErr } = await db.storage.from("audio").download(audio_path);
    if (dlErr || !file) return json({ error: "could not read audio" }, 404);

    const form = new FormData();
    form.append("file", file, audio_path.split("/").pop() ?? "audio.webm");
    form.append("model", "whisper-1");
    // Nudges the model toward proper nouns instead of confident
    // nonsense. Band names are exactly the worst case for ASR.
    form.append("prompt", "A short spoken idea for a band name, t-shirt, or hat.");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
      body: form,
    });

    if (!r.ok) return json({ error: await r.text() }, 502);
    const { text } = await r.json();

    await db.from("entries").update({ transcript: (text ?? "").trim() }).eq("id", entry_id);

    return json({ ok: true, transcript: text });
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
