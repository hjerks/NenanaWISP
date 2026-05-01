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

    // Auth via POST (id_token in body, not URL, so it isn't logged).
    if (params.action === 'google_auth') {
      return handleGoogleAuth_(e);
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

  // Google Identity Services (GSI) auth: client posts an ID token, we verify
  // it and issue our signed admin token. The frontend uses POST in normal
  // operation (so the token doesn't end up in URL/history), but the GET
  // route is left in place as a fallback.
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

  // Name comes in as first_name + last_name (current form) or full_name
  // (legacy/cached form). Combine into a single Full Name string so the
  // existing sheet schema and downstream code paths are unchanged.
  var firstName = String(p.first_name || '').trim();
  var lastName = String(p.last_name || '').trim();
  var combinedName = (firstName + ' ' + lastName).trim();
  if (!combinedName && p.full_name) {
    combinedName = String(p.full_name).trim();
  }
  if (!combinedName || !p.email || !String(p.email).trim() || !p.plan || !String(p.plan).trim()) {
    return HtmlService.createHtmlOutput(
      '<html><body><p>Missing required field (name, email, or plan).</p></body></html>'
    );
  }

  // Sanitize every free-text field so a malicious signup can't smuggle a
  // formula (=, +, @, -, leading tab/CR) into the sheet that would execute
  // when an admin opens the cell. Email/plan are not sanitized because
  // they're validated against a whitelist below; tos_agreed and the
  // install date are not free text.
  var email = String(p.email).trim().toLowerCase();
  var fullName = sanitizeForSheet_(combinedName);
  var phone = sanitizeForSheet_(String(p.phone || '').trim());
  var address = sanitizeForSheet_(String(p.address || '').trim());
  var city = sanitizeForSheet_(String(p.city || 'Nenana').trim());
  var state = sanitizeForSheet_(String(p.state || 'AK').trim());
  var zip = sanitizeForSheet_(String(p.zip || '').trim());
  var plan = String(p.plan).trim();
  var contactPref = sanitizeForSheet_(String(p.contact_pref || '').trim());
  var contactMethod = sanitizeForSheet_(String(p.contact_method || '').trim());
  var notes = sanitizeForSheet_(String(p.notes || '').trim());
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

  // Coordinates: prefer the lat/lon the customer pinned on the map (the
  // ground truth) over geocoding the typed address (which is unreliable
  // for Nenana). Fall back to geocoding only if no pin was placed.
  var lat = '', lon = '';
  var pinnedLat = parseFloat(p.pinned_lat);
  var pinnedLon = parseFloat(p.pinned_lon);
  if (isFinite(pinnedLat) && isFinite(pinnedLon)) {
    lat = pinnedLat;
    lon = pinnedLon;
  } else {
    var geo = geocodeAddress_({ address: [address, city, state, zip].filter(Boolean).join(', ') });
    if (geo && !geo.error) {
      lat = geo.lat;
      lon = geo.lon;
    } else if (geo && geo.error) {
      Logger.log('Lead geocode failed for ' + email + ': ' + (geo.message || geo.error));
    }
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

/**
 * Defang spreadsheet formula prefixes on user-supplied strings so they don't
 * execute as formulas when an admin opens the cell. Sheets treats any cell
 * starting with =, +, @, -, or a leading tab/CR as a formula. Prefixing
 * with a single quote forces it to be plain text without altering display.
 */
function sanitizeForSheet_(val) {
  if (val === null || val === undefined) return '';
  var s = String(val);
  if (/^[=+@\-\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}
