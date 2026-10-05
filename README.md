# Duda Preview Audit

QA audits for Duda sites using **only the preview link** — no Duda API required.

1. Add a site with its Duda preview link — any of the share links (`…/preview/<id>?…&device=all|desktop|mobile`) or the live URL. The app opens the real page behind Duda's preview frame automatically.
2. Upload the client's **Jira export** (PDF / XLSX / CSV, or paste the ticket text). It's parsed into "truth" facts — business name, phones, emails, address, hours, socials, services, cities — which you review and save. The file itself isn't stored.
3. **Run audit** → the app crawls the preview, checks every page against the Jira facts, runs rule checks, and (optionally) asks a free AI to review body copy and image alt text.
4. The team works the findings table: page, CSS selector (click to copy), found vs. expected, assignee, done checkbox, notes, ignore (false positive). Re-running an audit keeps done/ignored state and auto-resolves anything that's gone.

## Projects & Data Collection

**+ Add Project** → drop the Jira **Export Excel** (.xlsx) of the Website Build work item. The app:

1. Detects the **website type** (Basic / Advanced / MSO) and the **template** (e.g. *Single Location Template 31* from “Select Your Preferred … Site Design”).
2. Lists the **requested pages** (column D of the guideline sheet).
3. Builds a first **Data Collection** draft with the guideline rules: phone as `(000) 000-0000` + area-code check against the shop's state, job-applications email (falls back to Primary Contact Email with a note), *Auto Repair Shop*, *All Makes and Models* / *EXCEPT …*, Title-Case services, *State Inspection* for TX, HI, VA, MD, MA, WV, VT, NC, NH, LA, certifications mentioned in About Us/FAQ, special instructions.
4. You create the Duda site with that template and paste the **Editor URL** → the preview link for QA is filled automatically.
5. **Run all research** (each step can also run alone):
   - **Google Business Profile** — exact address (no country), `https://www.google.com/maps?cid=…`, Place ID, City/ST, name/phone/hours compared with Jira, mobile-shop warning. Needs a free SerpApi or Serper key, or paste the GBP link and it reads the CID/Place ID from it.
   - **Existing website** — reads the homepage + about/coupons/warranty/financing/services/amenities/FAQ pages, warns if it looks old or rebranded, decides the domain (with a note), collects social links.
   - **Web & social search** — Facebook, X, Instagram, YouTube, LinkedIn, Yelp (4★+ only), Pinterest, Vimeo, Snapchat, Reddit, TripAdvisor, Foursquare, TikTok; NAPA AutoCare, Carfax, RepairPal, BBB, AAA listings.
   - **AI fill & format** — hours in the house style, services to the minimum, amenities to the template's count, coupons/warranty/financing/certifications/About Us found online (Jira is always the fact; extras get a note).
   - **AI review** — flags contradictions and missing items.
6. **Copy for Google Sheet** pastes the whole block (labels, values, notes, pages) into your guideline sheet. The same data becomes the QA audit's facts automatically.

AI providers are tried in order (default: Cerebras → Mistral → Groq → Cloudflare Workers AI → Gemini → OpenRouter). A provider that hits its free limit rests automatically and the next one continues, so research never stops halfway. Search results and website text are cached per project, so re-running doesn't spend credits twice.

## What it checks

| Area | Checks |
|---|---|
| Contact info vs Jira | Phone numbers in text and `tel:` links, displayed number vs `tel:` target, emails and `mailto:`, state/ZIP, street address, Jira facts missing from the whole site |
| Hours | Each day's hours vs Jira; if Jira has no hours, hours that differ between pages |
| Business name | Near-miss spellings ("Joes Auto Repair" vs "Joe's Auto Repair"); name never shown |
| Content | Lorem ipsum / template text, 555-01xx numbers, `[City]`, `{{tokens}}`, outdated © year, services / cities from Jira not mentioned |
| Spelling & style | Automotive misspellings list, repeated words, missing space after punctuation, compound-adjective hyphens |
| Images | Missing alt, empty alt, filename-like alt, "image of…", too long/short, duplicate alts |
| Links | Broken internal links (with the page + selector that links there), `#` links, generic social links (`facebook.com/`), social links that don't match Jira, links to other Duda sites, `http://` |
| SEO | Missing / long / duplicate titles and meta descriptions, business name in title, H1 count |
| AI (optional) | Grammar, spelling, wrong facts, wrong city / other client's name, template leftovers; alt-text quality (Gemini can look at the actual images) with suggested alt |

Header / footer / nav findings are reported once as **Global** instead of once per page.

## Everything is free — no credit card anywhere

| Service | What it's for | Free plan |
|---|---|---|
| **GitHub** | Stores the code | Free, no card |
| **Vercel (Hobby)** | Runs the app, auto-deploys every commit | Free, no card |
| **Turso** | Database | 5 GB, no card, doesn't pause |
| **Cerebras**, **Mistral**, **Groq**, **Cloudflare Workers AI**, **Gemini**, **OpenRouter** | AI (used in order, automatic fallback) | Free tiers, no card |
| **SerpApi** / **Serper** / **Tavily** | Research search (GBP Place ID + CID, socials, listings) | 250/month · 2,500 one-time · 1,000/month, no card |

Login, two-factor codes and the security log are built in — no paid auth service needed.

## Deploy in 4 steps

### 1. Database — Turso (no card)
1. Sign up at https://turso.tech with GitHub.
2. Create a database (any name, closest region).
3. Copy its **URL** (`libsql://…`) and create a **token**.

### 2. Three secrets
Make two long random strings (any password generator, or Terminal):
```bash
openssl rand -base64 48   # → ENCRYPTION_KEY
openssl rand -base64 24   # → SETUP_TOKEN
```

### 3. Vercel
Import the GitHub repo in Vercel → **Settings → Environment Variables** → add:

| Name | Value |
|---|---|
| `ENCRYPTION_KEY` | 32+ random characters. **Never change it later** — saved AI keys and 2FA would stop working. |
| `SETUP_TOKEN` | 16+ random characters. Only needed for the first sign-in; you can delete it afterwards. |
| `TURSO_DATABASE_URL` | `libsql://…` |
| `TURSO_AUTH_TOKEN` | Turso token |

Optional: `DUDA_API_USERNAME` / `DUDA_API_PASSWORD` (only if the client ever allows API access), `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` (or paste them in Settings), `CRAWL_ALLOWED_HOSTS`.

Then **Deployments → Redeploy**.

### 4. First sign-in
Open the site → enter the `SETUP_TOKEN`, your name, email and a 12+ character password → scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password) → **save the recovery codes**. Then add your team in **Settings → Members**.

Free AI keys (Settings → AI providers): Gemini https://aistudio.google.com/apikey · Groq https://console.groq.com/keys · OpenRouter https://openrouter.ai/keys

## Security

| Threat | Protection |
|---|---|
| Stolen / guessed passwords | 12+ char password policy (blocks common ones), bcrypt (cost 12), **two-factor login required for everyone** by default (TOTP + 10 single-use recovery codes), lockout after 5 wrong passwords (15 min, doubling, max 24 h), per-IP and per-email rate limits, same error for wrong email / wrong password / locked (no account discovery), constant-time checks |
| Someone grabbing the Super Admin on a fresh deploy | First account needs `SETUP_TOKEN` from Vercel env; setup closes forever after |
| Session theft | Random 256-bit session tokens stored only as SHA-256 hashes; `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; 8 h idle / 7 day absolute expiry (configurable); new token after 2FA; password change, role change, deactivation or 2FA reset signs the person out everywhere; "Signed-in devices" page with remote sign-out |
| New members keeping weak temp passwords | Temporary passwords must be changed — and 2FA set up — before the app unlocks |
| Cross-site request forgery | `SameSite=Strict` cookies + `Origin`/`Sec-Fetch-Site` check on every write |
| XSS / injected scripts | React escaping, per-request **nonce Content-Security-Policy** (`strict-dynamic`, no inline/eval in production), `object-src 'none'`, `base-uri 'none'` |
| Clickjacking & browser leaks | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS (2 years, preload), `nosniff`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, COOP/CORP, `noindex` + `robots.txt` |
| SSRF (making the server fetch internal URLs) | Crawler only opens **allow-listed domains** (Settings → Security); only http/https on ports 80/443; every DNS answer checked **at connect time** (blocks private, loopback, link-local/metadata, CGNAT, IPv6 ULA, IPv4-mapped tricks, DNS rebinding); redirects re-checked hop by hop; 8 MB / 20 s caps; audit steps only accept pages inside that site's own preview |
| Malicious uploads | 4 MB cap, file type checked by its bytes (real PDF / real XLSX), zip-bomb check before opening XLSX, files never stored |
| Bad input / mass assignment / SQL injection | Every API body validated with strict Zod schemas; parameterised SQL only; numeric ids only |
| Spreadsheet formula injection | CSV export neutralises cells starting with `= + - @` |
| Leaked database | AI keys and 2FA secrets encrypted with AES-256-GCM using `ENCRYPTION_KEY` (kept in Vercel, not the DB); passwords bcrypt-hashed; recovery codes hashed |
| AI prompt injection from crawled pages | Page text is passed as untrusted data; AI output is only ever displayed as text, never executed |
| Insider mistakes / forensics | **Security log** (Super Admin): sign-ins, failures, lockouts, 2FA changes, role/password changes, settings changes — kept 90 days |
| Information leaks | Generic error messages with a reference id (details only in Vercel logs), no `X-Powered-By`, no source maps, `Cache-Control: no-store` on all API responses |
| Vulnerable packages | `npm audit` clean at release; Next.js on the latest patch |

**Your part:** keep `ENCRYPTION_KEY` and the Turso token secret, keep 2FA required for everyone, remove people in Settings → Members when they leave, and let Vercel/GitHub alert you to dependency updates (turn on **Dependabot** in the GitHub repo → Settings → Code security).

## Roles
- **Member** — add sites, import Jira, run audits, assign, check off, notes
- **Admin** — + add / deactivate members, reset passwords, unlock accounts, delete sites
- **Super Admin** — + security policy, crawl domains, AI keys, security log, reset someone's 2FA, grant admin roles

## Duda API mode (optional)
When `DUDA_API_USERNAME` / `DUDA_API_PASSWORD` are set, each site's **Jira facts** tab shows **Compare with Duda Business Info**, which pulls the site's content library and highlights anything that differs from Jira. Credentials stay in Vercel env only.

## Local development
```bash
npm install
cp .env.example .env.local   # leave TURSO_* blank to use ./local.db
npm run dev
```
