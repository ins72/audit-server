# What "perfect" looks like: Stremio-style streaming as a product

A vision and audit document for decision-makers. Assumption you set: **legal, licences and content rights are not a constraint**. Everything below is product, experience, architecture and business design. Evidence from the community is cited with links in section 2; where a source is a vendor blog or a secondary summary, it is labelled as such. Companion documents: [`PRODUCT_VISION.md`](PRODUCT_VISION.md) (package audit and roadmap) and [`CUSTOM_FEATURES.md`](CUSTOM_FEATURES.md) (what already exists in this repository).

## 1. The one-paragraph vision

A streaming product that feels as effortless as Netflix for the person on the sofa, as flexible as Stremio's add-on ecosystem for the enthusiast, and as controllable as a SaaS for the operator who sells it. The end user opens it on any screen, signs in once, picks a profile, and everything works: continue watching follows them, the first stream starts in seconds, subtitles are right, kids are safe, and failures fix themselves. The buyer (operator) installs it in minutes, puts their own name on it, connects Stripe, and sees every business number they need. The platform owner (you) sells the content/API service behind it as a subscription with metering, uptime guarantees and a status page.

## 2. What people actually say (evidence)

Sources are linked. Treat vendor blogs and secondary write-ups as signal, not proof; there are few formal feature-vote numbers publicly available.

**Reliability is the number one complaint.**
- A summary of Reddit discussion calls buffering and failed streams ["the single most discussed Stremio complaint"](https://redcurate.com/blog/stremio-reddit); add-ons often break after updates or when an add-on's upstream API goes down; Android TV / Fire Stick need cache clearing; some ISPs interfere; and new users do not understand what Stremio is or how to configure it.
- [Trustpilot](https://ca.trustpilot.com/review/strem.io) (3.8/5 from 237 reviews, mostly old): crashes and apps that will not open after updates, slow buffering, audio out of sync, external-player integration that does not load, subtitles re-appearing every episode, search results in the wrong language, watch progress marked as advanced without playback, and requests for a Samsung TV app and a full iOS app.

**Profiles, kids and family sharing are a known hole.**
- An [ELFHosted guide](https://docs.elfhosted.com/stremio-addons/guide/beyond-stremio/) (a hosting vendor with its own interest) says Stremio cannot give each person their own watch history, offers only filter configuration for kid safety (no age caps, limits or screen time), rates sharing with non-technical family as "difficult", and lacks Apple TV/iPhone/Roku/older-TV support. Power users move to Jellyfin-based bundles that add per-person profiles, age-capped libraries and daily screen time, priced around $18-29 a month versus $0-9 for Stremio.
- A [request for offline downloads](https://github.com/Stremio/stremio-features/issues/630) (one-click download, auto-download for library items, background download of upcoming episodes, saved quality/language preferences) sits in Stremio's feature tracker.

**Trust and safety are a recurring worry.**
- [RapidSeedbox](https://www.rapidseedbox.com/blog/is-stremio-safe) (a seedbox vendor): the main risks are unofficial add-ons, IP exposure on torrent add-ons, fake APKs and "premium"/modified builds that carry ads, trackers or malware; there is no vetting of community add-ons; Stremio's own Android app was off Google Play for 19 days in late 2025.
- Users already treat "modified Stremio builds" as a red-flag category. This matters for branding (section 3).

**What buyers of white-label platforms expect** ([MwareTV buyers guide](https://mwaretv.com/en/blog/white-label-ott-platform-buyers-guide), a vendor): native apps on the main device list (Android TV, Apple TV, Roku, Samsung Tizen, LG webOS, Fire TV, iOS, Android, web) rather than HTML5 wrappers, integrated billing (plans, trials, pay-per-view, dunning, subscriber portal), analytics, uptime SLAs of at least 99.9%, projected costs at 1,000 / 10,000 / 100,000 subscribers, no hidden fees, full branding control. Their rough price anchors: basic SaaS about $99-399/month, on-premise enterprise $50k-500k+ upfront.

**Synthesis: five jobs people want done**
1. It must play, quickly, every time (reliability, auto-fallback, clear errors).
2. Everyone in the household gets their own space (profiles, history, kids mode).
3. It must be easy to start and to share (onboarding, TV apps, one login).
4. I must be able to trust it (vetted sources, transparent privacy, no malware feeling).
5. Operators must be able to run it as a business (billing, analytics, support, branding).

## 3. The branding question: "Brand X × Stremio"

Your instinct: Stremio is known, so putting it next to the buyer's name builds trust. My honest read, setting legal aside as you asked:

**Where you are right**
- Stremio is a recognised product with a large, loyal user base and a strong reputation for UI and the add-on model. "Works with Stremio" tells a newcomer what it is in two words, which removes the "what is this?" problem that new users have.
- Familiarity lowers the learning cost: people who know Stremio know how Discover, Library and add-ons behave.

**Where it can backfire (and I think it is the bigger effect)**
- Users have been trained to distrust **modified or "premium" Stremio builds** (see the trust section above). A paid app that says "X Stremio" looks exactly like the pattern they were warned about. The more it resembles the original, the closer it sits to "fake APK".
- A buyer who puts *their* name on it wants customers to think of the buyer, not of a third party. Co-branding hands part of the relationship, and the support burden when Stremio changes, breaks or is delisted, to a brand the buyer does not control. That platform-risk already materialised once (the Google Play suspension).
- If Stremio's own reputation takes a hit (outage, policy change, a news story about piracy) every buyer inherits it overnight.
- It makes your own product impossible to differentiate. You would be selling "Stremio with a skin", which is the thing a free download already provides.

**What I would do instead (still gets you the trust)**
1. **Own brand first, with an honest compatibility line**: "Built on the open Stremio add-on standard" or "Compatible with Stremio add-ons" in the footer/About, not in the logo. Trust through transparency rather than borrowed identity.
2. **Make it feel like a complete product**, which is what actually creates trust: no sideloading, signed native apps in the stores, a status page, a privacy page that says exactly what is collected (this repository already implements download-my-data, erase, an audit trail and a statistics disclosure), visible support and a named company.
3. **Offer the buyer a switch**: `brandMode = own | powered-by` in admin settings. Let operators who want the association show a small "Powered by" badge, and let the rest stay clean. Test both with real conversion numbers rather than guessing.
4. **A "Verified add-ons" programme** is the real trust lever: you curate and monitor every source, publish uptime per source, and flag broken ones automatically. That answers the number-one fear (unvetted add-ons) better than any logo.

Verdict: co-branding probably costs more trust than it earns; make it an optional badge, default off, and A/B test it.

## 4. The perfect end-user experience (mapped to the complaints)

**Reliability layer (the headline feature)**
- **Source health scoring:** every stream source gets a live success rate and start-time measurement from real playback reports (this repository already collects plays, errors and error codes per add-on host). Rank streams by health, not by name.
- **Automatic fallback:** if a stream fails or stalls for N seconds, switch to the next best source mid-playback, resuming at the same timestamp, with no user action. Show a quiet "switching source" toast, not an error.
- **Pre-warming:** start fetching the next episode's best source while the current one plays; resolve and verify before the user presses play.
- **Plain-language errors with a fix button** ("This source is down. Try another / Report"), and a one-tap "Diagnose my connection" (bandwidth test, DNS, device capabilities).
- **Adaptive quality** and a bandwidth-aware default (do not pick a 4K source for a 10 Mbps connection).
- **Update safety:** staged rollouts, a version kill-switch and automatic rollback so "worked before the update" regressions stop being a recurring review theme.

**Profiles and family (the biggest product gap versus competitors)**
- Up to N profiles per account, avatar picker, per-profile Library, Continue Watching, watchlist, recommendations, subtitle/audio defaults and add-on set.
- **Kids profiles:** age rating caps, PIN to leave, allow-list of titles/collections, bedtime and daily time limits, "request access" notifications to a parent, viewing summary for the parent.
- **Household management** page: devices, profiles, who is watching now, remove a device, invite members (the roles, transfer, expiry and confirmation flow already built here is the foundation).

**Everywhere on first day**
- Native or high-quality PWA clients for iOS, Android, Android TV, Fire TV, Apple TV, Samsung Tizen, LG webOS, Roku and web; **QR-code login on TVs** (scan with phone, no typing); Chromecast / AirPlay; remote-control from phone.
- **Offline downloads** with smart rules (the request above), expiring rights where relevant.
- **Onboarding in under a minute:** three screens (pick language and interests, pick a plan or start trial, choose a profile), seeded personalised home, interactive "how it works" instead of documentation.

**Delight and discovery**
- Personalised home built from the product's own viewing data ("because you watched", "trending in your country", "finish what you started"), editorial rows curated by the operator, search that understands typos, languages and actors, and a global "what should I watch tonight?" picker.
- **Social:** watch party with synced playback and chat, shared lists, "friends are watching", reactions; households can see what each member added.
- **Playback quality:** correct subtitle handling (remember per-series choice, fix the "reappears every episode" class of bug), subtitle search and sync nudge, audio-track memory, skip intro/recap/credits, next-episode auto-play with countdown, picture-in-picture, accurate watch progress, Dolby/HDR badges where supported.
- **Accessibility:** full keyboard and screen-reader support, captions styling, reduced motion, colour-blind-safe UI, 10-foot (TV) navigation design.
- **Trust surface:** a "My privacy" page (what is collected, download, erase), source transparency (which provider is serving this stream), no ads unless chosen.

## 5. The perfect operator platform (what the buyer gets)

1. **Setup wizard** (5 minutes): domain, admin account, brand, plans, Stripe, email, content API key; each step verified live.
2. **Brand studio:** name, logo, colours, fonts, app icon and splash for each platform, legal pages, email and push templates, custom domain, translations, all without a rebuild. Optional "Powered by" badge.
3. **Business dashboard:** MRR, ARR, churn, LTV, trial-to-paid, cohort retention, revenue by plan and country, failed payments and recoveries, coupon performance, forecast. (Retention, activation, trends, at-risk payers and conversion already exist here as server statistics.)
4. **Content and quality dashboard:** top titles, finish rate, error rate by source, cost per watched hour, source health, geographic and device mix, peak concurrency.
5. **Subscriber management:** search a user, see plan, devices, history, comp or refund, impersonate-to-support (audited), ban, export, erase (all already present as operator actions).
6. **Monetisation toolkit:** plans and add-ons, annual and family plans, coupons, referral credits, gift cards, pay-per-view and rentals, regional pricing, free tiers with ads, dunning and win-back emails, upgrade prompts at the right moments.
7. **Marketing and lifecycle:** automated email/push (welcome, trial ending, payment failed, "we miss you" aimed at the at-risk list), segments from statistics, announcement banners, A/B tests on the paywall and on the badge question in section 3.
8. **Operations:** one-click updates, staged rollouts, backups to object storage with restore, monitoring and alerting, status page, audit log, role-based admin (owner, support, finance), API and webhooks to their own tools.
9. **Multi-tenant / reseller mode:** one platform serving many brands by domain, each with its own plans, data isolation and branding; you see all tenants, they see only theirs.

## 6. The perfect platform layer (what you operate)

- **Accounts:** an independent identity system (passwords with modern hashing, email verification, passkeys, 2FA, device management, SSO for businesses) exposed through a Stremio-compatible API so existing clients work unchanged. This is the dependency to remove first (it also unlocks real password-change and security analytics).
- **Content API as a first-party add-on:** catalogue, metadata, streams and subtitles under a per-customer key. Metering, quotas and tiers; per-key anomaly detection; automatic health checks and failover across providers; CDN and edge caching; signed short-lived stream URLs.
- **Reliability engineering:** multi-region, queue-based pipelines, rate limiting, circuit breakers per upstream provider, a published SLO (99.9%+), incident tooling and a public status page. This is the product the buyer pays monthly for.
- **Data platform:** event pipeline (play, stop, error, switch, search, paywall), warehouse, privacy-aware retention, per-tenant exports. The current JSON statistics are the prototype of this.
- **Security and trust:** SOC2-style controls, secrets management, dependency scanning, penetration test, abuse and fraud detection (account sharing across continents), transparent security page.
- **Storage:** relational database with migrations and read replicas, object storage for backups, Redis for rate limits, counters and sessions.

## 7. How it compares

| | Plain Stremio | Jellyfin-based bundles | This product (perfect) |
|---|---|---|---|
| Profiles and kids | Limited | Yes | Yes, with limits and parent tools |
| Setup for family | Difficult | Type an address | QR login, one account |
| Reliability | Add-on dependent | Managed | Health-scored, auto-fallback |
| Devices | Gaps (iOS, Apple TV, Roku) | Wide | Wide (native or PWA) |
| Billing and analytics | None | Vendor-side | Built in for the operator |
| Trust | Unvetted add-ons | Managed | Verified sources, privacy centre |
| Price signal | $0-9 | about $18-29/mo | Operator decides |

## 8. What to show the people in charge (demo script, 10 minutes)

1. **Cold open:** a phone scans a QR code on a TV; the profile picker appears; first stream starts in under three seconds.
2. **A stream fails on purpose:** the player switches source silently and resumes at the same second. Show the operator dashboard recording it.
3. **Kids profile:** PIN, age cap, time limit, parent summary.
4. **Operator side:** setup wizard, brand studio re-skins the app live (own name), Stripe test payment, plan sharing and roles (works today).
5. **Business view:** MRR/churn/retention, the at-risk list becoming a win-back email, source health table (the data collection for this exists today).
6. **The API service:** keys, usage meter, uptime, status page.
7. **The ask:** the decisions listed in `PRODUCT_VISION.md` section 9, plus the branding question in section 3 above.

## 9. Success metrics

- **Time to first frame** (p50 / p95), **stream success rate**, **auto-fallback rescue rate**, errors per 100 plays by source.
- **Activation** (share who watch within 24h), day-1/7/30 retention, weekly active households, hours per active household.
- **Revenue:** trial-to-paid, churn, ARPU, expansion (family/add-ons), failed-payment recovery.
- **Operator health:** time to first brand launch (target under 30 minutes), support tickets per 1,000 users, NPS for buyers and for end users.
- **Platform:** API uptime vs SLO, p95 latency per resource, cost per delivered hour.

## 10. Roadmap sketch to "perfect"

| Phase | Focus | Outcome |
|---|---|---|
| 0 (now) | Login gate, paywall, sharing, statistics, operator tooling | Working prototype |
| 1 | Database, setup wizard, brand studio, admin dashboard, observability | Installable by a buyer |
| 2 | Profiles, kids mode, coupons/trials/annual, emails, backups, docs, demo | Sellable package |
| 3 | Reliability layer: health scoring, auto-fallback, pre-warm, diagnostics | The differentiator |
| 4 | Own accounts + Stremio-compatible API; QR login; PWA/TV clients | Independent platform |
| 5 | Content API service: keys, metering, SLA, status page | Recurring revenue |
| 6 | Multi-tenant resale, recommendations, social, offline | Platform scale |

## 11. Honest risks to put on the table (even with legal parked)

- **The content API is an operations business**: uptime, abuse and provider cost drive margins more than software does.
- **Native TV apps are expensive** to build and certify; start with a strong PWA and prioritise the top two TV platforms by your buyers' audience.
- **Platform dependence** on the Stremio core and its API until your own accounts layer exists; pin versions, test every upgrade in a staging channel.
- **Brand perception** (section 3): the "modified Stremio" association is a real trust hazard in this community.
- **Evidence quality:** much of the public feedback comes from reviews and vendor blogs, not formal feature votes; validate with your own users (the statistics already collected here, plus interviews) before committing to a long roadmap.

Sources: [RedCurate Reddit summary](https://redcurate.com/blog/stremio-reddit) · [Trustpilot reviews](https://ca.trustpilot.com/review/strem.io) · [ELFHosted "beyond Stremio"](https://docs.elfhosted.com/stremio-addons/guide/beyond-stremio/) · [Stremio offline feature request](https://github.com/Stremio/stremio-features/issues/630) · [RapidSeedbox safety article](https://www.rapidseedbox.com/blog/is-stremio-safe) · [MwareTV white-label buyers guide](https://mwaretv.com/en/blog/white-label-ott-platform-buyers-guide).
