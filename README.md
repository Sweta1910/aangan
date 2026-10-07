# Saathi — clickable prototype

> **No judgement. Just moms.** A women-only, judgement-free community app for Indian moms,
> launching city by city — starting with **Mountain View / Sunnyvale, CA**.

Personal project prototype (not UCP work). Pure static HTML/CSS/JS with mock data: no backend,
no build step, no API keys. Every person, post and event is fictional; avatars are initials only.

## Run it

```bash
cd apps/saathi/web && python3 -m http.server 8765
```

Open **http://localhost:8765/** — on a laptop it shows in a phone frame with quick links to every
screen; on a phone it fills the screen. Opening `web/index.html` directly also works.

**Rename the app:** change `brand.name` in [`web/data.js`](web/data.js) — that's the only place.

## Screens

| # | Screen | Route | What to try |
|---|--------|-------|-------------|
| 1 | Welcome | `#welcome` | Brand, promise, "Get started" |
| 2 | City picker | `#onboard/city` | MV/Sunnyvale live; tap Cupertino / San Jose / Fremont / Santa Clara to join a waitlist |
| 3 | About you | `#onboard/about` | Nickname, anonymous-by-default toggle, kids' stages, 10 languages |
| 4 | Verification (mock) | `#onboard/verify` | Phone code + selfie check → "Enter Saathi" |
| 5 | Home feed | `#home` | 9 circles, posts (anonymous or nickname), Hug / Been there / Helpful reactions — no downvotes |
| 6 | Circle | `#circle/<id>` | Join, filtered posts, "Ask in this circle" |
| 7 | Ask | `#ask` | Pick circle, anonymous toggle, **"See the kindness check in action"** |
| 8 | Question detail | `#q/p1` | Verified-expert (IBCLC) reply, ⋯ report/block/hide, reply box with kindness check |
| 9 | Nearby | `#nearby` | Opt-in first (off by default) → stylised neighbourhood map + mom cards → "Say hi" → mock accept unlocks chat |
| 10 | Meetups | `#meetups` | Stroller walk at Shoreline, Las Palmas playdate, Diwali potluck… RSVP + "Going" tab |
| 11 | Chat | `#chat/m1`, `#chats` | 1:1 chat with mock replies, ⋯ block/report |
| 12 | Me | `#me` | Anonymous default, nearby visibility, who can message me, blocked list, guidelines, reset demo |

Screenshots of every screen (390×844 @2x) are in [`screenshots/`](screenshots/).

## What's mocked vs real

| Real (works in the browser) | Mocked |
|---|---|
| Navigation, all screens, deep links | Phone/selfie verification (simulated delay) |
| Posting questions & replies, reactions, RSVPs, privacy settings, block/hide — saved in `localStorage` | Other moms accepting your "hi" (auto-accepts after ~2.5s) and chat replies (canned) |
| Kindness check (client-side phrase list + curated rewrite) | Moderation / reports (toast only), expert verification |
| Neighbourhood-only map (inline SVG, no map API) | All people, posts, events and counts |

"Reset demo" on the Me tab clears local state.

## Tests & screenshots

```bash
# structural tests (stdlib only; run by the scoped ship gate)
python3 -m unittest apps/saathi/tests/test_saathi_web.py
# re-shoot all screens + smoke-test the JS (needs Playwright; fails on any page error)
/Users/swetashree/liquid/venv/bin/python apps/saathi/scripts/screenshots.py
```

## Next steps

1. **Share a public link** (it's static, so any of these take minutes):
   - **Netlify Drop** — drag the `web/` folder onto app.netlify.com/drop → instant URL.
   - **GitHub Pages** — push `web/` to a repo, enable Pages.
   - **Firebase Hosting** — `firebase init hosting` (public dir `web`) → `firebase deploy`.
2. **Real backend** — Firebase Auth (phone OTP) + Firestore for posts/circles/chats, a real
   selfie-verification vendor, server-side moderation for the kindness check, and coarse
   geohash-to-neighbourhood bucketing so exact location is never stored.
3. **Name & brand** — validate "Saathi" (trademark/app-store availability), test the tagline with
   a few moms, and get a proper logo/illustration set.
4. **Pilot** — 20–30 MV/Sunnyvale moms, measure weekly posts per member and hi→chat conversion.
