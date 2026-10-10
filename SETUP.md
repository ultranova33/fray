# Fray setup

Do these in order. Steps 1–2 happen once in Supabase; the rest are per device.

## 1. Database and accounts (Supabase dashboard)

1. **SQL Editor** › New query › paste all of `supabase-setup.sql` › **Run**.
   It creates accounts, private tasks, the 3-day history, the read-only
   quote bank (your 40 quotes), and the push tables. It's safe to run again.
   If you ran the older version before, its tables are kept as `*_v1_backup`.
2. **Authentication › Sign In / Providers › Email**: turn **off** "Confirm email" and save.
   Fray uses usernames, so no confirmation email could ever arrive.

## 2. Phone alerts: timers and the 9pm nudge (Supabase dashboard)

1. **Edge Functions › Secrets**: add the four lines from `push-keys.txt`
   (only in your folder, never in GitHub). Set `VAPID_SUBJECT` to
   `mailto:` + your email first.
2. **Edge Functions › Deploy a new function › Via Editor**: name it
   `send-due-pushes`, paste `supabase/functions/send-due-pushes/index.ts`,
   deploy, then open the function's settings and turn **Verify JWT off**.
3. **SQL Editor**: paste `supabase/push-schedule.sql` › **Run**.
   This checks every 30 seconds for finished timers and 9pm nudges.

If you already did step 2 for the earlier version, just redeploy the
function with the new code. The secrets and schedule stay the same.

## 3. Try it on your computer

In this folder run `npx serve` (needs Node.js) and open the address it prints,
usually http://localhost:3000. Double-clicking index.html won't work.

## 4. Put it online (Vercel)

Import the GitHub repo at vercel.com › Add New › Project. There's no build
step: Framework Preset "Other", leave the build command empty, and deploy.
You get an `https://….vercel.app` link. Phones need this https link for
installing and for alerts.

## 5. Phones

- **iPhone**: open the link in Safari › Share › **Add to Home Screen** ›
  open Fray from the Home Screen › profile › Turn on alerts.
- **Android**: open the link in Chrome › menu › **Install app**, or use the APK.
- **Android APK**: pwabuilder.com › paste the Vercel link › Package for stores ›
  Android › download. Friends install it by allowing "install unknown apps".

## Editing quotes (admin)

Only in the Supabase dashboard: **Table Editor › quotes**. Add rows, edit them,
or untick `active` to hide one. The app can only read this table.

## If something's off

- **"Supabase is asking for email confirmation"**: step 1.2 isn't done.
- **"Couldn't load your profile"**: run `supabase-setup.sql` (step 1.1).
- **Sign-up says the email address is invalid**: open `app.js`, change
  `EMAIL_DOMAIN` to another domain you like (for example `fray-app.com`), and
  redeploy. Do this before anyone signs up, since existing accounts use the old one.
- **No push on iPhone**: alerts only work from the Home Screen app (iOS 16.4+).
