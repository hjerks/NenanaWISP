# NenanaWISP Billing Platform

DIY ISP billing and subscriber management for the Nenana Native Association WISP.

**Stack:** Google Sheets + Google Apps Script + Stripe + GitHub Pages
**Cost:** $0/month (only Stripe's 2.9% + $0.30 per transaction)

---

## Setup Guide

### Prerequisites

- Google account
- Stripe account (free to create at stripe.com)
- GitHub account (free at github.com)

---

### Step 1: Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet
2. Name it **"Nenana WISP Management"**
3. Keep this tab open -- you'll need it in Step 3

---

### Step 2: Set Up Stripe

#### 2a: Create Products (start in Test Mode)

1. Log into [Stripe Dashboard](https://dashboard.stripe.com)
2. Make sure **Test mode** is toggled ON (top right)
3. Go to **Products > + Add product** and create three products:

| Product Name | Price | Billing |
|---|---|---|
| Residential 50/10 Mbps | $XX.00/month | Recurring |
| Residential 100/20 Mbps | $XX.00/month | Recurring |
| Business 100/100 Mbps | $XX.00/month | Recurring |

4. For each product, copy the **Price ID** (starts with `price_...`)

#### 2b: Configure Customer Portal

1. Go to **Settings > Billing > Customer portal**
2. Enable: Update payment method, View invoices, Cancel subscription
3. Set the return URL to your site (update later once deployed)

#### 2c: Get Your API Key

1. Go to **Developers > API keys**
2. Copy the **Secret key** (starts with `sk_test_...`)

---

### Step 3: Set Up Google Apps Script

1. In your Google Sheet, go to **Extensions > Apps Script**
2. Delete any default code in `Code.gs`
3. Create the following files (use the `+` button next to Files):
   - `Code.gs`
   - `Stripe.gs`
   - `Sheets.gs`
   - `Email.gs`
   - `Webhooks.gs`
   - `Admin.gs`
   - `Dashboard.gs`

4. Copy the contents of each file from the `apps-script/` folder in this repo into the corresponding Apps Script file

5. Go to **Project Settings** (gear icon) > **Script Properties** and add these:

| Property | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (your Stripe secret key) |
| `PRICE_RES_50_10` | `price_...` (Residential 50/10 price ID) |
| `PRICE_RES_100_20` | `price_...` (Residential 100/20 price ID) |
| `PRICE_BUS_100_100` | `price_...` (Business 100/100 price ID) |
| `SUCCESS_URL` | `https://YOURUSERNAME.github.io/NenanaWISP/success.html` |
| `CANCEL_URL` | `https://YOURUSERNAME.github.io/NenanaWISP/cancel.html` |
| `PORTAL_RETURN_URL` | `https://YOURUSERNAME.github.io/NenanaWISP/` |
| `FROM_NAME` | `Nenana Internet` |
| `CONTACT_EMAIL` | Your contact email |
| `CONTACT_PHONE` | Your contact phone |
| `ADMIN_EMAILS` | Comma-separated admin emails (e.g., `you@gmail.com`) |
| `ADMIN_SECRET` | A random string (e.g., generate at random.org, 32+ chars) |

Optional properties:
| Property | Value |
|---|---|
| `INSTALL_FEE_PRICE` | `price_...` (one-time install fee, if applicable) |
| `LATE_FEE_AMOUNT_CENTS` | `1000` (late fee in cents, default $10) |
| `LATE_FEE_GRACE_DAYS` | `7` (days before late fee applies) |

6. **Initialize the sheets:** In Apps Script, select `initializeAllSheets` from the function dropdown and click Run. Authorize when prompted. This creates all tabs with headers.

7. **Deploy the web app:**
   - Click **Deploy > New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**
   - Copy the web app URL (ends with `/exec`)

8. **Set up the daily trigger:** Select `setupDailyTrigger` from the function dropdown and click Run. This enables daily past-due account checks at 9 AM.

---

### Step 4: Configure Stripe Webhook

1. In Stripe Dashboard, go to **Developers > Webhooks**
2. Click **+ Add endpoint**
3. Paste your Apps Script web app URL (from Step 3.7)
4. Select these events:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
5. Click **Add endpoint**
6. Copy the **Signing secret** (`whsec_...`) and add it as `WEBHOOK_SECRET` in Script Properties (for future use)

---

### Step 5: Deploy the Website (GitHub Pages)

1. Push this repo to GitHub:
   ```bash
   git add .
   git commit -m "Initial NenanaWISP billing platform"
   git remote add origin https://github.com/YOURUSERNAME/NenanaWISP.git
   git push -u origin main
   ```

2. Go to your repo on GitHub > **Settings > Pages**
3. Source: **Deploy from a branch**
4. Branch: **main**, Folder: **/docs**
5. Click **Save**
6. Your site will be live at `https://YOURUSERNAME.github.io/NenanaWISP/`

7. **Update the Apps Script URL in the frontend:**
   - Edit `docs/js/signup.js` -- replace `YOUR_APPS_SCRIPT_URL_HERE` with your web app URL
   - Edit `docs/admin/js/admin.js` -- replace `YOUR_APPS_SCRIPT_URL_HERE` with the same URL
   - Commit and push

---

### Step 6: Test End-to-End

1. Visit your GitHub Pages site
2. Fill out the signup form and submit
3. Check your Google Sheet -- a new row should appear in the **Leads** tab
4. Check your email for the checkout link
5. Complete checkout using Stripe test card: `4242 4242 4242 4242` (any future expiry, any CVC)
6. Verify:
   - Lead status updates to "Paid"
   - New row appears in **Customers** tab
   - New row appears in **Installs** tab
   - Welcome email is received
   - Webhook_Log shows processed events
7. Test the admin portal at `/admin/`
8. Test payment failure with card: `4000 0000 0000 0341`

---

### Step 7: Go Live

When ready for real customers:

1. In Stripe, switch to **Live mode**
2. Create the same three products with real prices
3. Copy the new live Price IDs and secret key
4. Update Script Properties:
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - All `PRICE_*` properties → new live `price_...` IDs
5. Create a new webhook endpoint in Stripe (live mode) with the same Apps Script URL
6. Update `WEBHOOK_SECRET` with the new signing secret
7. Test with a real card

---

### Adding a Custom Domain (Optional)

1. Purchase a domain (e.g., Cloudflare, Namecheap, Google Domains)
2. Create a `CNAME` file in `docs/` with your domain name
3. In your domain registrar, add a CNAME record pointing to `YOURUSERNAME.github.io`
4. In GitHub repo Settings > Pages, add your custom domain
5. Update `SUCCESS_URL`, `CANCEL_URL`, and `PORTAL_RETURN_URL` in Script Properties

---

## File Structure

```
NenanaWISP/
  docs/                          # GitHub Pages (public website)
    index.html                   # Landing page with plans + signup form
    css/style.css                # Site styling
    js/signup.js                 # Form validation + submission
    account.html                 # Customer account portal page
    success.html                 # Post-checkout success
    cancel.html                  # Checkout cancelled
    tos.html                     # Terms of service
    support.html                 # Support + FAQ
    admin/                       # Admin portal (Google OAuth protected)
      index.html
      css/admin.css
      js/admin.js
  apps-script/                   # Google Apps Script (copy to Script Editor)
    Code.gs                      # Entry point, routing, form handler
    Stripe.gs                    # Stripe API helpers
    Sheets.gs                    # Sheet operations + row finders
    Email.gs                     # Email templates
    Webhooks.gs                  # Webhook processing + auto-suspension
    Admin.gs                     # Admin API + authentication
    Dashboard.gs                 # Dashboard formulas setup
```

## Google Sheet Tabs

| Tab | Purpose |
|---|---|
| Leads | New signups awaiting payment |
| Customers | Active/historical subscribers |
| Installs | Installation scheduling |
| Equipment | Network equipment inventory |
| Support | Support ticket tracking |
| Webhook_Log | Stripe event debugging log |
| Dashboard | Summary stats + formulas |

## Architecture

```
Customer → GitHub Pages (signup form) → Apps Script (doPost) → Stripe (checkout)
                                              ↓                      ↓
                                        Google Sheet          Stripe webhooks
                                              ↑                      ↓
                                        Apps Script (webhook handler) ←
                                              ↓
                                    Sheet update + automated email
```

Admin portal (GitHub Pages /admin/) authenticates via Google OAuth through Apps Script, then fetches data via signed API tokens.
