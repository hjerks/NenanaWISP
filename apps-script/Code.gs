/**
 * Code.gs -- Main entry point: doPost/doGet routing, form handler, config
 * NenanaWISP Billing Platform
 *
 * SCRIPT PROPERTIES (set in Apps Script > Project Settings > Script Properties):
 *   STRIPE_SECRET_KEY    - sk_test_... or sk_live_...
 *   PRICE_RES_50_10      - price_... for Residential 50/10 Mbps
 *   PRICE_RES_100_20     - price_... for Residential 100/20 Mbps
 *   PRICE_BUS_100_100    - price_... for Business 100/100 Mbps
 *   SUCCESS_URL           - e.g., https://yoursite.github.io/NenanaWISP/success.html
 *   CANCEL_URL            - e.g., https://yoursite.github.io/NenanaWISP/cancel.html
 *   PORTAL_RETURN_URL     - e.g., https://yoursite.github.io/NenanaWISP/
 *   FROM_NAME             - Display name for outgoing emails (e.g., "NNA Community Broadband")
 *   CONTACT_EMAIL         - Reply-to / contact email address
 *   CONTACT_PHONE         - Contact phone number
 *   ADMIN_EMAILS          - Comma-separated list of authorized admin email addresses
 *   ADMIN_SECRET          - Random secret string for signing admin tokens
 *   INSTALL_FEE_PRICE     - (Optional) price_... for one-time install fee
 *   LATE_FEE_AMOUNT_CENTS - (Optional) Late fee amount in cents (default: 1000 = $10)
 *   LATE_FEE_GRACE_DAYS   - (Optional) Grace period in days before late fee (default: 7)
 */

// ── doPost: Single entry point for form submissions + webhooks ──

function doPost(e) {
  try {
    // Route based on source parameter or content type
    var params = e.parameter || {};

    if (params.source === 'signup_form') {
      return handleFormSubmission_(e);
    }

    // Otherwise, treat as Stripe webhook (JSON body with .type)
    return handleWebhook(e);

  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
    return HtmlService.createHtmlOutput(
      '<html><body><p>An error occurred. Please try again or contact us.</p></body></html>'
    );
  }
}

// ── doGet: Admin API + basic status ────────────────────────

function doGet(e) {
  var params = e.parameter || {};
  var action = params.action || '';

  // Admin API endpoints
  if (action.indexOf('admin_') === 0) {
    return handleAdminRequest_(e);
  }

  // Auth endpoint for admin login (legacy Session-based — kept for back-compat)
  if (action === 'auth') {
    return handleAdminAuth_(e);
  }

  // Google Identity Services (GSI) auth: client posts an ID token, we verify
  // it and issue our signed admin token. This works across consumer Gmail
  // accounts, unlike Session.getActiveUser().
  if (action === 'google_auth') {
    return handleGoogleAuth_(e);
  }

  // Public geocoding endpoint for the signup page coverage check.
  // Scoped to AK addresses (see geocodeAddress_) so abuse vector is small.
  if (action === 'public_geocode') {
    var result = geocodeAddress_({ address: params.address });
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Default: simple status response
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', service: 'NenanaWISP Billing' })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ── Form Submission Handler ────────────────────────────────

function handleFormSubmission_(e) {
  var p = e.parameter;

  // Validate required fields
  var required = ['full_name', 'email', 'plan'];
  for (var i = 0; i < required.length; i++) {
    if (!p[required[i]] || !String(p[required[i]]).trim()) {
      return HtmlService.createHtmlOutput(
        '<html><body><p>Missing required field: ' + sanitize_(required[i]) + '</p></body></html>'
      );
    }
  }

  var email = String(p.email).trim().toLowerCase();
  var fullName = String(p.full_name).trim();
  var phone = String(p.phone || '').trim();
  var address = String(p.address || '').trim();
  var city = String(p.city || 'Nenana').trim();
  var state = String(p.state || 'AK').trim();
  var zip = String(p.zip || '').trim();
  var plan = String(p.plan).trim();
  var contactPref = String(p.contact_pref || '').trim();
  var contactMethod = String(p.contact_method || '').trim();
  var notes = String(p.notes || '').trim();
  var tosAgreed = String(p.tos_agreed || 'false').trim();
  // 'YYYY-MM-DD' or 'ASAP'. Validation is light: tech reviews every request.
  var requestedInstallDate = String(p.requested_install_date || 'ASAP').trim();

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return HtmlService.createHtmlOutput(
      '<html><body><p>Invalid email address.</p></body></html>'
    );
  }

  // Validate plan name
  var validPlans = ['Residential 50/10 Mbps', 'Residential 100/20 Mbps', 'Business 100/100 Mbps'];
  if (validPlans.indexOf(plan) === -1) {
    return HtmlService.createHtmlOutput(
      '<html><body><p>Invalid plan selection.</p></body></html>'
    );
  }

  var rowKey = Utilities.getUuid();

  // Geocode best-effort. Failure does not block signup - tech can geocode
  // later via the admin Coverage view.
  var lat = '', lon = '';
  var geo = geocodeAddress_({ address: [address, city, state, zip].filter(Boolean).join(', ') });
  if (geo && !geo.error) {
    lat = geo.lat;
    lon = geo.lon;
  } else if (geo && geo.error) {
    Logger.log('Lead geocode failed for ' + email + ': ' + (geo.message || geo.error));
  }

  ensureHeaders_(TAB_LEADS, LEADS_HEADERS);

  // No Stripe customer or checkout yet. Payment is created later, when the
  // tech marks the install complete in the admin portal (admin_complete_install).
  var leadRow = [
    new Date(),                // Timestamp
    fullName,
    email,
    phone,
    address,
    city,
    state,
    zip,
    plan,
    contactPref,
    contactMethod,
    '',                        // Install Preference (deprecated; replaced by Requested Install Date)
    notes,
    tosAgreed,
    rowKey,
    '',                        // Stripe Customer ID (filled at install-complete)
    '',                        // Checkout Link (filled at install-complete)
    'Survey Requested',        // Lead Status
    new Date(),                // Created Date
    lat,
    lon,
    requestedInstallDate
  ];

  appendRow_(TAB_LEADS, leadRow);

  // Notify the tech(s) that a new request needs a site survey.
  try {
    sendNewRequestTechEmail_({
      fullName: fullName,
      email: email,
      phone: phone,
      address: address,
      city: city,
      state: state,
      zip: zip,
      plan: plan,
      requestedInstallDate: requestedInstallDate,
      notes: notes,
      lat: lat,
      lon: lon,
      coveragePrediction: String(p.coverage_prediction || '')
    });
  } catch (techErr) {
    Logger.log('Tech notification email failed (non-critical): ' + techErr.message);
  }

  // Confirmation email to the customer that we've got their request.
  try {
    sendRequestReceivedEmail_(email, fullName, plan, requestedInstallDate);
  } catch (custErr) {
    Logger.log('Customer confirmation email failed (non-critical): ' + custErr.message);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ success: true, status: 'survey_requested' })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ── Utility ────────────────────────────────────────────────

/**
 * Basic HTML sanitization to prevent XSS in email templates and responses.
 */
function sanitize_(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
