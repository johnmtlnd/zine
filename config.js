/* ============================================================
   CONFIG — the four things that make this yours.
   ============================================================ */

export const CONFIG = {

  /* The name. Shows in the masthead, the browser tab, and the
     home-screen icon label. Change it here and it changes
     everywhere — but note it also shapes the display type, so
     a much longer name may want a smaller --font-size in the
     .masthead__name rule.

     Placeholder for now, per your call. */
  NAME: "Off Cuts",

  /* From Supabase → Project Settings → API.
     The anon key is DESIGNED to be public — row-level security
     is what actually protects your data, not this string. It is
     safe in a public repo. Your email addresses are not, which
     is why they live in the allowed_emails table instead. */
  SUPABASE_URL: "https://luvgeqxsgkotbbvcrlid.supabase.co/",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1dmdlcXhzZ2tvdGJidmNybGlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NjQ4OTQsImV4cCI6MjEwMjI0MDg5NH0.0kamwFkIuowWk7pxuGMW5j3OwXUqkQUUAlVVzNuvDXs",

  /* Public VAPID key for web push. Generate it when you set up
     the notify function — see SETUP.md step 6. Leave as-is to
     ship without push for now; everything else still works. */
  VAPID_PUBLIC_KEY: "BEpoFpIZJ4HQiO37nkJDO0EfcIS9ht3aZnRtGLsFuDH0G4Ju7KeWvOjqUEHryvb16uNrS9t8PVYoUXyBlFRDEB0",
};
