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

  // Auth endpoint for admin login
  if (action === 'auth') {
    return handleAdminAuth_(e);
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
  var installPref = String(p.install_pref || '').trim();
  var notes = String(p.notes || '').trim();
  var tosAgreed = String(p.tos_agreed || 'false').trim();

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

  // Generate a unique row key
  var rowKey = Utilities.getUuid();

  // Create or find Stripe customer
  var customer = createOrGetStripeCustomer_({
    email: email,
    name: fullName,
    phone: phone,
    address: { line1: address, city: city, state: state, zip: zip }
  });

  // Get the price ID for the selected plan
  var priceId = getPriceIdForPlan_(plan);

  // Check for optional installation fee
  var installFeePrice = propOr('INSTALL_FEE_PRICE', '');

  // Create checkout session
  var session = createCheckoutSession_({
    customerId: customer.id,
    priceId: priceId,
    rowKey: rowKey,
    email: email,
    planName: plan,
    installFeePrice: installFeePrice || null
  });

  // Generate portal link
  var portalUrl = '';
  try {
    portalUrl = createPortalSession_(customer.id);
  } catch (portalErr) {
    Logger.log('Portal session creation failed (non-critical): ' + portalErr.message);
  }

  // Ensure sheet headers exist
  ensureHeaders_(TAB_LEADS, LEADS_HEADERS);

  // Write lead row
  var leadRow = [
    new Date(),           // Timestamp
    fullName,             // Full Name
    email,                // Email
    phone,                // Phone
    address,              // Service Address
    city,                 // City
    state,                // State
    zip,                  // ZIP
    plan,                 // Plan
    contactPref,          // Contact Preference
    contactMethod,        // Contact Method
    installPref,          // Install Preference
    notes,                // Notes
    tosAgreed,            // TOS Agreed
    rowKey,               // Row Key
    customer.id,          // Stripe Customer ID
    session.url,          // Checkout Link
    'Checkout Sent',      // Lead Status
    new Date()            // Created Date
  ];

  appendRow_(TAB_LEADS, leadRow);

  // Send checkout email
  sendCheckoutEmail_(email, fullName, session.url, portalUrl, plan);

  // Return the checkout URL as JSON.
  // The signup page JavaScript will handle the redirect client-side.
  // This avoids Google's sandboxed iframe which blocks external redirects.
  return ContentService.createTextOutput(
    JSON.stringify({ success: true, checkoutUrl: session.url })
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
