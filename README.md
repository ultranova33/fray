# Fray

Your day, dealt fresh. A playful daily task app: 10 moods that shuffle on
every launch, timers with phone alerts, a 3-day history, and a 9pm nudge to
plan tomorrow. Private accounts, synced in real time across your devices.

Plain HTML, CSS and JavaScript (no build step), backed by Supabase.

| File | What it does |
| --- | --- |
| `index.html` | Page layout: sign-in, Today, History, sheets |
| `styles.css` | Soft-brutalist styling; all colors come from the mood |
| `moods.js` | The 10 mood palettes and the launch shuffle |
| `app.js` | Accounts, tasks, swipes, timers, history, profile, push |
| `quotes.js` | Built-in quote bank (fallback when offline) |
| `sw.js` | Service worker: offline shell and push notifications |
| `manifest.json`, `icons/` | Install as an app (PWA / APK) |
| `supabase-setup.sql` | Database tables, privacy rules, history, nudge logic |
| `supabase/functions/send-due-pushes` | Sends timer and 9pm pushes |

Setup steps are in [SETUP.md](SETUP.md).
