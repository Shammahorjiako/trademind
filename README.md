# TradeMind

Trading analysis app (crypto, forex, stocks, indices). Front end is one static file (`index.html`).
Accounts, payments and shared prices run in a Cloudflare Worker (`worker/worker.js`).

## Files
- `index.html` : the app. Hosted free on GitHub Pages.
- `worker/worker.js` : email-code accounts, Google/Apple sign-in, Paystack payments, shared price feed.
- Keep your existing `manifest.webmanifest` and `icon-192.png` (and any other icons) in the same folder as `index.html`.

## Never put these in GitHub
Paystack secret key, Resend/Brevo key, Twelve Data key, AUTH_KEY, PRO_SIGN_KEY. They go in Cloudflare only (Part B).

---
## Part A. Put the app on GitHub Pages
1. github.com > **+** > **New repository**. Name it `trademind`. Public. Create.
2. **Add file > Upload files**. Upload `index.html`, `README.md`, `.gitignore`, your `manifest.webmanifest` and `icon-192.png`. (The `worker` folder can be uploaded too. It contains no secrets.) Tap **Commit changes**.
3. **Settings > Pages**. Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save.
4. After about a minute your app is at `https://YOURNAME.github.io/trademind/`. This is your **APP_URL** (keep the trailing slash).

## Part B. Set up the Worker (Cloudflare)
1. Cloudflare dashboard > **Storage & Databases > KV > Create namespace**. Name it `trademind-users`.
2. **Workers & Pages** > open your worker (the one in `LIVE_API` inside `index.html`) > **Settings > Bindings > Add > KV namespace**. Variable name: `USERS`. Pick `trademind-users`.
3. **Edit code**. Open `worker/worker.js`. Near the bottom, paste your OLD worker where it says "YOUR EXISTING PRICE CODE": rename its `export default { async fetch(...) {...} }` to `const oldWorker = { async fetch(...) {...} }`. Then paste the whole file into the editor and **Deploy**.
4. **Settings > Variables and Secrets**. Add:

| Name | Type | Value |
|---|---|---|
| AUTH_KEY | Secret | any long random text (40+ characters) |
| PRO_SIGN_KEY | Secret | a different long random text |
| PAYSTACK_SECRET | Secret | Paystack **live secret key** (use the test key first) |
| TD_KEY | Secret | your Twelve Data key (if your old code uses another name, rename one of them) |
| RESEND_KEY | Secret | from Part C |
| MAIL_FROM | Text | `TradeMind <login@yourdomain.com>` |
| APP_URL | Text | your GitHub Pages address from Part A |
| GOOGLE_CLIENT_ID / APPLE_CLIENT_ID | Text | only when you switch those buttons on |

## Part C. Email codes (the 6-digit code)
The Worker emails a 6-digit code (valid 10 minutes, 5 wrong tries, 5 emails per hour per address). There is no link to click.
**Option 1, Resend:** resend.com > create account > **Domains > Add domain** (you must own a domain) > add the DNS records it shows > wait for Verified > **API Keys > Create**. Put the key in `RESEND_KEY`. `MAIL_FROM` must use that domain.
**Option 2, Brevo (no domain needed):** brevo.com > create account > **Senders > add and verify your email address** > **SMTP & API > API keys**. In Cloudflare add secret `BREVO_KEY` and text `MAIL_FROM_EMAIL` (your verified sender address). If `BREVO_KEY` exists the Worker uses Brevo.
Check each provider's current free limits before launch.

## Part D. Point the app at your Worker and test
1. In `index.html`, search `LIVE_API=` and confirm it is your Worker's address.
2. Open your GitHub Pages address > Create account > a code arrives by email > enter it > pick a market.
3. Test: wrong code, Resend code, Forgot password, sign out and back in.

## Part E. Before real users
1. In `<head>` of `index.html` add: `<script>window.TM_AUTH={preview:false,google:'',apple:'',appleRedirect:''};window.TM_DEBUG=false;</script>`. This removes the "Preview without an account" button and the red error box.
2. Put your support email in `LEGAL.contact` (search `contact:''`).
3. Paystack: switch from test to live key. Do a real small payment.
4. Read Twelve Data's terms about showing prices to the public.
5. Have a lawyer read the Terms, Risk disclaimer and Refund policy.
6. If login ever shows "Exceeded CPU", the free Worker plan is too small for password hashing. Use the Workers Paid plan or lower the PBKDF2 `iterations` in `worker.js`.
