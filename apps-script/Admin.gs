/**
 * Admin.gs -- Admin API endpoints with Google OAuth authentication
 * NenanaWISP Billing Platform
 *
 * Authentication flow:
 * 1. Admin visits /admin/ page on GitHub Pages
 * 2. Page redirects to Apps Script URL with ?action=auth
 * 3. Apps Script checks Session.getActiveUser() against ADMIN_EMAILS
 * 4. If authorized, returns a signed token (HMAC-SHA256)
 * 5. Admin portal stores token in sessionStorage
 * 6. All subsequent API calls include token as ?token=...
 * 7. Apps Script validates token signature and expiry on every request
 */

// ── Token Configuration ────────────────────────────────────

var TOKEN_EXPIRY_HOURS = 8;

// ── Auth Endpoint ──────────────────────────────────────────

/**
 * Handle admin authentication.
 * Called via doGet with ?action=auth
 * If the user is in ADMIN_EMAILS, generates a signed token and redirects back to the admin page.
 */
function handleAdminAuth_(e) {
  var user = Session.getActiveUser().getEmail();
  var adminEmails = propOr('ADMIN_EMAILS', '').split(',').map(function(e) { return e.trim().toLowerCase(); });
  var redirectUrl = e.parameter.redirect || '';

  if (!user || adminEmails.indexOf(user.toLowerCase()) === -1) {
    return HtmlService.createHtmlOutput(
      '<html><body>' +
      '<h2>Access Denied</h2>' +
      '<p>Your Google account (' + sanitize_(user || 'unknown') + ') is not authorized to access the admin portal.</p>' +
      '<p>Contact the system administrator to request access.</p>' +
      '</body></html>'
    ).setTitle('Access Denied');
  }

  // Generate signed token
  var token = generateAdminToken_(user);

  return handleAdminAuthRedirect_(token, e);
}

/**
 * Verify a Google ID token (JWT) from Google Identity Services on the
 * client, then issue our own signed admin token if the email is in
 * ADMIN_EMAILS. This is the replacement for handleAdminAuth_ now that
 * Session.getActiveUser().getEmail() does not return consumer Gmail
 * addresses across accounts.
 *
 * Expected params:
 *   id_token -- the JWT credential returned by google.accounts.id
 */
function handleGoogleAuth_(e) {
  var idToken = (e.parameter || {}).id_token || '';
  if (!idToken) {
    return jsonResponse_({ error: 'missing_id_token' });
  }

  // Verify the token via Google's tokeninfo endpoint. This also decodes
  // the email and audience claims for us -- no local JWT parsing needed.
  var tokenInfo;
  try {
    var resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    var code = resp.getResponseCode();
    tokenInfo = JSON.parse(resp.getContentText());
    if (code < 200 || code >= 300 || tokenInfo.error) {
      return jsonResponse_({ error: 'invalid_token', message: tokenInfo.error_description || tokenInfo.error || 'Could not verify token' });
    }
  } catch (err) {
    Logger.log('Google auth verify error: ' + err.message);
    return jsonResponse_({ error: 'verify_failed', message: err.message });
  }

  // Confirm the token was issued for our OAuth client. This is the check
  // that stops someone from replaying an ID token they got for a different
  // app against our backend.
  var expectedClientId = prop('GOOGLE_OAUTH_CLIENT_ID');
  if (tokenInfo.aud !== expectedClientId) {
    return jsonResponse_({ error: 'wrong_audience', message: 'Token was not issued for this application.' });
  }

  // Require a verified email -- otherwise someone with an unverified
  // alias could impersonate a legitimate admin.
  if (tokenInfo.email_verified !== 'true' && tokenInfo.email_verified !== true) {
    return jsonResponse_({ error: 'email_not_verified' });
  }

  var email = String(tokenInfo.email || '').toLowerCase();
  if (!email) {
    return jsonResponse_({ error: 'no_email' });
  }

  var adminEmails = propOr('ADMIN_EMAILS', '').split(',').map(function(x) { return x.trim().toLowerCase(); });
  if (adminEmails.indexOf(email) === -1) {
    return jsonResponse_({
      error: 'not_authorized',
      message: 'Your Google account (' + email + ') is not authorized to access the admin portal.'
    });
  }

  var token = generateAdminToken_(email);
  return jsonResponse_({ token: token, email: email, expires_in: TOKEN_EXPIRY_HOURS * 3600 });
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Legacy redirect helper -- only reachable via the old ?action=auth flow.
 * Kept so existing bookmarks don't break while admins migrate to GSI.
 */
function handleAdminAuthRedirect_(token, e) {
  var redirectUrl = e.parameter.redirect || '';

  // Redirect back to admin page with token.
  // Apps Script HtmlService runs inside a sandboxed iframe, so a plain
  // window.location.href only navigates the iframe -- the user appears
  // "stuck" at script.google.com. Use window.top.location.href to navigate
  // the parent frame back to nnabroadband.com, with a visible link as
  // a manual fallback if the browser blocks the script.
  if (redirectUrl) {
    var safeUrl = sanitize_(redirectUrl) + '#token=' + token;
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head>' +
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:48px;color:#1f2937;}a{color:#1a5276;font-weight:600;}</style>' +
      '<script>' +
      'var t = ' + JSON.stringify(safeUrl) + ';' +
      'try { (window.top || window).location.href = t; } catch (e) { window.location.href = t; }' +
      '</script>' +
      '</head><body>' +
      '<p>Signing you in...</p>' +
      '<p style="margin-top:16px;"><a href="' + safeUrl + '" target="_top">Click here if you are not redirected automatically</a></p>' +
      '</body></html>'
    );
  }

  // If no redirect URL, return the token as JSON
  return ContentService.createTextOutput(
    JSON.stringify({ token: token, expires_in: TOKEN_EXPIRY_HOURS * 3600 })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ── Token Management ───────────────────────────────────────

/**
 * Generate a signed admin token.
 * Token format: base64(email:expiry):signature
 */
function generateAdminToken_(email) {
  var secret = prop('ADMIN_SECRET');
  var expiry = new Date().getTime() + (TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
  var payload = email + ':' + expiry;
  var payloadB64 = Utilities.base64Encode(payload);
  var signature = computeHmac_(secret, payloadB64);
  return payloadB64 + '.' + signature;
}

/**
 * Validate an admin token. Returns the email if valid, null if invalid.
 */
function validateAdminToken_(token) {
  if (!token) return null;

  var parts = token.split('.');
  if (parts.length !== 2) return null;

  var payloadB64 = parts[0];
  var signature = parts[1];
  var secret = prop('ADMIN_SECRET');

  // Verify signature
  var expectedSig = computeHmac_(secret, payloadB64);
  if (signature !== expectedSig) return null;

  // Decode and check expiry
  var payload = Utilities.newBlob(Utilities.base64Decode(payloadB64)).getDataAsString();
  var colonIdx = payload.lastIndexOf(':');
  if (colonIdx === -1) return null;

  var email = payload.substring(0, colonIdx);
  var expiry = parseInt(payload.substring(colonIdx + 1), 10);

  if (new Date().getTime() > expiry) return null;

  // Verify email is still in admin list
  var adminEmails = propOr('ADMIN_EMAILS', '').split(',').map(function(e) { return e.trim().toLowerCase(); });
  if (adminEmails.indexOf(email.toLowerCase()) === -1) return null;

  return email;
}

/**
 * Compute HMAC-SHA256 signature.
 */
function computeHmac_(secret, data) {
  var signature = Utilities.computeHmacSha256Signature(data, secret);
  return Utilities.base64Encode(signature);
}

// ── Admin API Router ───────────────────────────────────────

/**
 * Route admin API requests. Called by doGet when action starts with 'admin_'.
 * All admin endpoints require a valid token.
 */
function handleAdminRequest_(e) {
  var token = e.parameter.token || '';
  var adminEmail = validateAdminToken_(token);

  if (!adminEmail) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'unauthorized', message: 'Invalid or expired admin token' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  var action = e.parameter.action;
  var result;

  switch (action) {
    case 'admin_dashboard':
      result = getAdminDashboard_();
      break;
    case 'admin_customers':
      result = getAdminCustomers_(e.parameter);
      break;
    case 'admin_customer_detail':
      result = getAdminCustomerDetail_(e.parameter);
      break;
    case 'admin_leads':
      result = getAdminLeads_();
      break;
    case 'admin_installs':
      result = getAdminInstalls_();
      break;
    case 'admin_support':
      result = getAdminSupport_();
      break;
    case 'admin_equipment':
      result = getAdminEquipment_();
      break;
    case 'admin_update_install':
      result = updateInstall_(e.parameter);
      break;
    case 'admin_update_support':
      result = updateSupportTicket_(e.parameter);
      break;
    case 'admin_create_ticket':
      result = adminCreateTicket_(e.parameter);
      break;
    case 'admin_update_customer_notes':
      result = updateCustomerNotes_(e.parameter);
      break;
    case 'admin_update_equipment':
      result = updateEquipment_(e.parameter);
      break;
    case 'admin_create_equipment':
      result = createEquipment_(e.parameter);
      break;
    case 'admin_suspend_customer':
      result = suspendCustomer_(e.parameter);
      break;
    case 'admin_unsuspend_customer':
      result = unsuspendCustomer_(e.parameter);
      break;
    case 'admin_create_customer':
      result = createCustomerManual_(e.parameter);
      break;
    case 'admin_update_lead':
      result = updateLead_(e.parameter);
      break;
    case 'admin_resend_checkout':
      result = resendCheckout_(e.parameter);
      break;
    case 'admin_delete_lead':
      result = deleteLead_(e.parameter);
      break;
    case 'admin_delete_customer':
      result = deleteCustomer_(e.parameter);
      break;
    case 'admin_change_plan':
      result = changePlan_(e.parameter);
      break;
    case 'admin_customer_payments':
      result = getCustomerPayments_(e.parameter);
      break;
    case 'admin_convert_lead_manual':
      result = convertLeadManual_(e.parameter);
      break;
    case 'admin_mark_invoice_paid':
      result = markInvoicePaid_(e.parameter);
      break;
    case 'admin_reader_status':
      result = adminReaderStatus_();
      break;
    case 'admin_reader_charge':
      result = adminReaderCharge_(e.parameter);
      break;
    case 'admin_reader_cancel':
      result = adminReaderCancel_();
      break;
    case 'admin_reader_payment_status':
      result = adminReaderPaymentStatus_(e.parameter);
      break;
    case 'admin_reader_action_status':
      result = adminReaderActionStatus_();
      break;
    case 'admin_reader_start_payment':
      result = adminReaderStartPayment_(e.parameter);
      break;
    case 'admin_reader_charge_product':
      result = adminReaderChargeProduct_(e.parameter);
      break;
    case 'admin_reader_finalize_product_charge':
      result = adminReaderFinalizeProductCharge_(e.parameter);
      break;
    default:
      result = { error: 'unknown_action', message: 'Unknown admin action: ' + action };
  }

  return ContentService.createTextOutput(
    JSON.stringify(result)
  ).setMimeType(ContentService.MimeType.JSON);
}

// ── Admin Data Endpoints ───────────────────────────────────

/**
 * Dashboard summary data.
 */
function getAdminDashboard_() {
  var customers = getDataAsObjects_(TAB_CUSTOMERS);
  var leads = getDataAsObjects_(TAB_LEADS);
  var installs = getDataAsObjects_(TAB_INSTALLS);
  var support = getDataAsObjects_(TAB_SUPPORT);

  var activeCount = 0;
  var pastDueCount = 0;
  var canceledCount = 0;
  var mrr = 0;
  var pastDueCustomers = [];
  var planBreakdown = {};

  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    var status = c['Subscription Status'];
    if (status === 'active') {
      activeCount++;
      var price = parseFloat(c['Monthly Price']) || 0;
      mrr += price;
      var plan = c['Plan'] || 'Unknown';
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    } else if (status === 'past_due') {
      pastDueCount++;
      pastDueCustomers.push({
        id: c['Stripe Customer ID'],
        name: c['Full Name'],
        email: c['Email'],
        plan: c['Plan'],
        lastPayment: c['Last Payment Date']
      });
    } else if (status === 'canceled') {
      canceledCount++;
    }
  }

  var pendingLeads = leads.filter(function(l) {
    return l['Lead Status'] === 'Checkout Sent';
  }).length;

  var pendingInstalls = installs.filter(function(inst) {
    return inst['Status'] === 'Pending' || inst['Status'] === 'Scheduled';
  }).length;

  var openTickets = support.filter(function(t) {
    return t['Status'] === 'Open' || t['Status'] === 'In Progress';
  }).length;

  // Recent signups (last 30 days)
  var thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  var recentSignups = customers.filter(function(c) {
    var signup = new Date(c['Signup Date']);
    return signup >= thirtyDaysAgo;
  }).map(function(c) {
    return { id: c['Stripe Customer ID'], name: c['Full Name'], plan: c['Plan'], date: c['Signup Date'] };
  });

  return {
    summary: {
      activeSubscribers: activeCount,
      pastDue: pastDueCount,
      canceled: canceledCount,
      pendingLeads: pendingLeads,
      pendingInstalls: pendingInstalls,
      openTickets: openTickets,
      mrr: mrr
    },
    planBreakdown: planBreakdown,
    pastDueCustomers: pastDueCustomers,
    recentSignups: recentSignups
  };
}

/**
 * Customer list with optional search.
 */
function getAdminCustomers_(params) {
  // Run schema migration in case Billing Method column was added since
  // this sheet was last written to.
  ensureHeaders_(TAB_CUSTOMERS, CUSTOMERS_HEADERS);
  var customers = getDataAsObjects_(TAB_CUSTOMERS);
  var search = (params.search || '').toLowerCase().trim();

  if (search) {
    customers = customers.filter(function(c) {
      return (c['Full Name'] || '').toLowerCase().indexOf(search) !== -1 ||
             (c['Email'] || '').toLowerCase().indexOf(search) !== -1 ||
             (c['Service Address'] || '').toLowerCase().indexOf(search) !== -1 ||
             (c['Stripe Customer ID'] || '').toLowerCase().indexOf(search) !== -1;
    });
  }

  return {
    customers: customers.map(function(c) {
      return {
        stripeCustomerId: c['Stripe Customer ID'],
        name: c['Full Name'],
        email: c['Email'],
        phone: c['Phone'],
        address: c['Service Address'],
        plan: c['Plan'],
        status: c['Subscription Status'],
        lastPayment: c['Last Payment Date'],
        signupDate: c['Signup Date'],
        subscriptionId: c['Stripe Subscription ID'],
        monthlyPrice: c['Monthly Price'],
        portalLink: c['Portal Link'],
        lastEvent: c['Last Event'],
        notes: c['Notes'],
        billingMethod: c['Billing Method'] || 'auto'
      };
    }),
    total: customers.length
  };
}

/**
 * Single customer detail.
 */
function getAdminCustomerDetail_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  var data = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var customer = {};
  for (var i = 0; i < CUSTOMERS_HEADERS.length; i++) {
    customer[CUSTOMERS_HEADERS[i]] = data[i];
  }

  // Find related equipment
  var equipment = getDataAsObjects_(TAB_EQUIPMENT).filter(function(eq) {
    return (eq['Assigned To'] || '').toLowerCase() === (customer['Email'] || '').toLowerCase();
  });

  // Find related support tickets
  var tickets = getDataAsObjects_(TAB_SUPPORT).filter(function(t) {
    return (t['Email'] || '').toLowerCase() === (customer['Email'] || '').toLowerCase();
  });

  // Find install info
  var installs = getDataAsObjects_(TAB_INSTALLS).filter(function(inst) {
    return (inst['Email'] || '').toLowerCase() === (customer['Email'] || '').toLowerCase();
  });

  return {
    customer: customer,
    equipment: equipment,
    tickets: tickets,
    installs: installs
  };
}

/**
 * All leads.
 */
function getAdminLeads_() {
  return { leads: getDataAsObjects_(TAB_LEADS) };
}

/**
 * All installs.
 */
function getAdminInstalls_() {
  return { installs: getDataAsObjects_(TAB_INSTALLS) };
}

/**
 * All support tickets.
 */
function getAdminSupport_() {
  return { tickets: getDataAsObjects_(TAB_SUPPORT) };
}

/**
 * All equipment.
 */
function getAdminEquipment_() {
  return { equipment: getDataAsObjects_(TAB_EQUIPMENT) };
}

// ── Admin Write Endpoints ──────────────────────────────────

/**
 * Update an installation record.
 */
function updateInstall_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var sheet = getSheet_(TAB_INSTALLS);
  if (params.scheduled_date) sheet.getRange(rowNum, 6).setValue(params.scheduled_date);
  if (params.technician) sheet.getRange(rowNum, 7).setValue(params.technician);
  if (params.equipment) sheet.getRange(rowNum, 8).setValue(params.equipment);
  if (params.status) sheet.getRange(rowNum, 9).setValue(params.status);
  if (params.completion_date) sheet.getRange(rowNum, 10).setValue(params.completion_date);
  if (params.notes) sheet.getRange(rowNum, 11).setValue(params.notes);

  // When install is marked "Completed", end the Stripe trial to start billing
  if (params.status === 'Completed') {
    try {
      var email = sheet.getRange(rowNum, 2).getValue(); // Email column
      var customerRow = findRow_(TAB_CUSTOMERS, C_.EMAIL, String(email).toLowerCase());
      if (customerRow) {
        var custData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
        var subId = custData[C_.STRIPE_SUB_ID - 1];
        if (subId) {
          // End trial immediately -- triggers first charge
          var secret = prop('STRIPE_SECRET_KEY');
          UrlFetchApp.fetch('https://api.stripe.com/v1/subscriptions/' + subId, {
            method: 'post',
            headers: { 'Authorization': 'Bearer ' + secret },
            payload: { 'trial_end': 'now' },
            muteHttpExceptions: true
          });
          Logger.log('Ended trial for ' + email + ' (install completed)');
        }
      }
    } catch (e) {
      Logger.log('Failed to end trial on install completion: ' + e.message);
      // Non-critical -- don't fail the install update
    }
  }

  return { success: true };
}

/**
 * Update a support ticket.
 */
function updateSupportTicket_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var sheet = getSheet_(TAB_SUPPORT);
  if (params.status) sheet.getRange(rowNum, 7).setValue(params.status);
  if (params.resolution) sheet.getRange(rowNum, 8).setValue(params.resolution);
  if (params.resolved_date) sheet.getRange(rowNum, 9).setValue(params.resolved_date);
  if (params.notes) sheet.getRange(rowNum, 10).setValue(params.notes);

  return { success: true };
}

/**
 * Create a new support ticket from the admin portal.
 */
function adminCreateTicket_(params) {
  if (!params.customer_name || !params.email || !params.category || !params.description) {
    return { error: 'missing_fields' };
  }
  createSupportTicket_(params.customer_name, params.email, params.category, params.description);
  return { success: true };
}

/**
 * Update customer notes.
 */
function updateCustomerNotes_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  writeCell_(TAB_CUSTOMERS, customerRow, C_.NOTES, params.notes || '');
  return { success: true };
}

/**
 * Update an equipment record.
 */
function updateEquipment_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var sheet = getSheet_(TAB_EQUIPMENT);
  if (params.device_type) sheet.getRange(rowNum, 1).setValue(params.device_type);
  if (params.make_model) sheet.getRange(rowNum, 2).setValue(params.make_model);
  if (params.serial) sheet.getRange(rowNum, 3).setValue(params.serial);
  if (params.mac) sheet.getRange(rowNum, 4).setValue(params.mac);
  if (params.ip) sheet.getRange(rowNum, 5).setValue(params.ip);
  if (params.vlan) sheet.getRange(rowNum, 6).setValue(params.vlan);
  if (params.hasOwnProperty('assigned_to')) sheet.getRange(rowNum, 7).setValue(params.assigned_to);
  if (params.location) sheet.getRange(rowNum, 9).setValue(params.location);
  if (params.status) sheet.getRange(rowNum, 10).setValue(params.status);
  if (params.hasOwnProperty('notes')) sheet.getRange(rowNum, 11).setValue(params.notes);

  return { success: true };
}

/**
 * Create a new equipment record.
 */
function createEquipment_(params) {
  var row = [
    params.device_type || '',
    params.make_model || '',
    params.serial || '',
    params.mac || '',
    params.ip || '',
    params.vlan || '',
    params.assigned_to || '',
    params.install_date || '',
    params.location || '',
    params.status || 'Available',
    params.notes || ''
  ];
  appendRow_(TAB_EQUIPMENT, row);
  return { success: true };
}

// ── Suspend / Unsuspend ────────────────────────────────────

/**
 * Suspend a customer's subscription in Stripe and update the sheet.
 */
function suspendCustomer_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var subId = customerData[C_.STRIPE_SUB_ID - 1];
  var email = customerData[C_.EMAIL - 1];
  var name = customerData[C_.FULL_NAME - 1];

  if (!subId) return { error: 'no_subscription' };

  // Pause the subscription in Stripe
  try {
    var secret = prop('STRIPE_SECRET_KEY');
    var url = 'https://api.stripe.com/v1/subscriptions/' + subId;
    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + secret },
      payload: { 'pause_collection[behavior]': 'void' },
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Stripe suspend error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }

  // Update sheet
  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, 'suspended');
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'admin_suspended');

  // Send notification email
  try {
    sendSuspensionNoticeEmail_(email, name);
  } catch (e) {
    Logger.log('Suspension email failed: ' + e.message);
  }

  return { success: true };
}

/**
 * Unsuspend a customer's subscription in Stripe and update the sheet.
 */
function unsuspendCustomer_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var subId = customerData[C_.STRIPE_SUB_ID - 1];
  var email = customerData[C_.EMAIL - 1];
  var name = customerData[C_.FULL_NAME - 1];

  if (!subId) return { error: 'no_subscription' };

  // Resume the subscription in Stripe
  try {
    var secret = prop('STRIPE_SECRET_KEY');
    var url = 'https://api.stripe.com/v1/subscriptions/' + subId;
    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + secret },
      payload: { 'pause_collection': '' },
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Stripe unsuspend error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }

  // Update sheet
  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, 'active');
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'admin_unsuspended');

  // Send notification email
  try {
    sendReactivationEmail_(email, name);
  } catch (e) {
    Logger.log('Reactivation email failed: ' + e.message);
  }

  return { success: true };
}

// ── Manual Customer Creation ───────────────────────────────

/**
 * Create a customer manually from the admin portal.
 * Creates Stripe customer + subscription, adds to sheet.
 */
function createCustomerManual_(params) {
  if (!params.full_name || !params.email || !params.plan) {
    return { error: 'missing_fields', message: 'Name, email, and plan are required.' };
  }

  var email = String(params.email).trim().toLowerCase();
  var fullName = String(params.full_name).trim();
  var phone = String(params.phone || '').trim();
  var address = String(params.address || '').trim();
  var plan = String(params.plan).trim();
  var notes = String(params.notes || '').trim();

  // Create or find Stripe customer
  var customer = createOrGetStripeCustomer_({
    email: email,
    name: fullName,
    phone: phone,
    address: { line1: address, city: 'Nenana', state: 'AK', zip: '' }
  });

  // Get price ID
  var priceId = getPriceIdForPlan_(plan);
  var rowKey = Utilities.getUuid();

  // Check for optional installation fee
  var installFeePrice = propOr('INSTALL_FEE_PRICE', '');

  // Create a Checkout Session (sends payment link instead of charging directly)
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
  } catch (e) {}

  // Add to Leads sheet (will be promoted to Customers when they pay)
  ensureHeaders_(TAB_LEADS, LEADS_HEADERS);
  var leadRow = [
    new Date(),           // Timestamp
    fullName,             // Full Name
    email,                // Email
    phone,                // Phone
    address,              // Service Address
    'Nenana',             // City
    'AK',                 // State
    '',                   // ZIP
    plan,                 // Plan
    '',                   // Contact Preference
    '',                   // Contact Method
    '',                   // Install Preference
    notes,                // Notes
    'true',               // TOS Agreed
    rowKey,               // Row Key
    customer.id,          // Stripe Customer ID
    session.url,          // Checkout Link
    'Checkout Sent',      // Lead Status
    new Date()            // Created Date
  ];
  appendRow_(TAB_LEADS, leadRow);

  // Send checkout email
  sendCheckoutEmail_(email, fullName, session.url, portalUrl, plan);

  return { success: true, customerId: customer.id };
}

// ── Lead Management ────────────────────────────────────────

/**
 * Update a lead's status.
 */
function updateLead_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var sheet = getSheet_(TAB_LEADS);
  if (params.status) sheet.getRange(rowNum, L.LEAD_STATUS).setValue(params.status);
  if (params.hasOwnProperty('notes')) sheet.getRange(rowNum, L.NOTES).setValue(params.notes);

  return { success: true };
}

/**
 * Resend the checkout link email to a lead.
 * If the original checkout link has expired, creates a new one.
 */
function resendCheckout_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var leadData = readRow_(TAB_LEADS, rowNum, LEADS_HEADERS.length);
  var email = leadData[L.EMAIL - 1];
  var name = leadData[L.FULL_NAME - 1];
  var plan = leadData[L.PLAN - 1];
  var custId = leadData[L.STRIPE_CUST_ID - 1];
  var rowKey = leadData[L.ROW_KEY - 1];

  if (!email || !custId) return { error: 'missing_data' };

  // Create a new checkout session (old ones expire after 24h)
  var priceId = getPriceIdForPlan_(plan);
  var installFeePrice = propOr('INSTALL_FEE_PRICE', '');

  var session = createCheckoutSession_({
    customerId: custId,
    priceId: priceId,
    rowKey: rowKey,
    email: email,
    planName: plan,
    installFeePrice: installFeePrice || null
  });

  // Update the checkout link in the sheet
  var sheet = getSheet_(TAB_LEADS);
  sheet.getRange(rowNum, L.CHECKOUT_LINK).setValue(session.url);
  sheet.getRange(rowNum, L.LEAD_STATUS).setValue('Checkout Sent');

  // Generate portal link
  var portalUrl = '';
  try {
    portalUrl = createPortalSession_(custId);
  } catch (e) {}

  // Send the email
  sendCheckoutEmail_(email, name, session.url, portalUrl, plan);

  return { success: true };
}

/**
 * Delete a customer. Cancels their Stripe subscription and removes the row.
 */
function deleteCustomer_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var subId = customerData[C_.STRIPE_SUB_ID - 1];

  // Cancel the subscription in Stripe if it exists
  if (subId) {
    try {
      var secret = prop('STRIPE_SECRET_KEY');
      UrlFetchApp.fetch('https://api.stripe.com/v1/subscriptions/' + subId, {
        method: 'delete',
        headers: { 'Authorization': 'Bearer ' + secret },
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log('Stripe cancel error: ' + e.message);
    }
  }

  // Delete the row from the sheet
  var sheet = getSheet_(TAB_CUSTOMERS);
  sheet.deleteRow(customerRow);

  return { success: true };
}

/**
 * Delete (mark as deleted) a lead.
 */
function deleteLead_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var sheet = getSheet_(TAB_LEADS);
  sheet.getRange(rowNum, L.LEAD_STATUS).setValue('Deleted');

  return { success: true };
}

// ── Plan Change ────────────────────────────────────────────

/**
 * Change a customer's plan -- updates the Stripe subscription to the new
 * price (with prorations) and updates the sheet's Plan and Monthly Price
 * columns. Requires an active Stripe subscription.
 */
function changePlan_(params) {
  var custId = params.id || '';
  var newPlan = params.plan || '';
  if (!custId || !newPlan) return { error: 'missing_params', message: 'Customer ID and new plan are required.' };

  var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (!customerRow) return { error: 'not_found' };

  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var subId = customerData[C_.STRIPE_SUB_ID - 1];
  var currentPlan = customerData[C_.PLAN - 1];

  if (newPlan === currentPlan) {
    return { error: 'same_plan', message: 'Customer is already on this plan.' };
  }

  if (!subId) {
    // No Stripe subscription -- just update the sheet (manual customer)
    var amt = 0;
    try { amt = getMonthlyAmountForPlan_(newPlan); } catch (e) {}
    writeCell_(TAB_CUSTOMERS, customerRow, C_.PLAN, newPlan);
    if (amt) writeCell_(TAB_CUSTOMERS, customerRow, C_.MONTHLY_PRICE, amt);
    writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'plan_changed_manual');
    return { success: true, newAmount: amt, manual: true };
  }

  var newPriceId;
  try { newPriceId = getPriceIdForPlan_(newPlan); }
  catch (e) { return { error: 'invalid_plan', message: e.message }; }

  try {
    // Look up the current subscription item ID (Stripe needs this to update the price)
    var sub = stripeGet_('/v1/subscriptions/' + subId);
    if (!sub.items || !sub.items.data || !sub.items.data[0]) {
      return { error: 'no_sub_items', message: 'Subscription has no items.' };
    }
    var itemId = sub.items.data[0].id;

    // Update the subscription item with the new price.
    // proration_behavior=create_prorations issues a prorated charge/credit
    // immediately for the partial billing period.
    var updated = stripeRequest_('/v1/subscriptions/' + subId, 'post', {
      'items[0][id]': itemId,
      'items[0][price]': newPriceId,
      'proration_behavior': 'create_prorations'
    });

    var newAmount = (updated.items.data[0].price.unit_amount || 0) / 100;

    writeCell_(TAB_CUSTOMERS, customerRow, C_.PLAN, newPlan);
    writeCell_(TAB_CUSTOMERS, customerRow, C_.MONTHLY_PRICE, newAmount);
    writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'plan_changed');

    return { success: true, newAmount: newAmount };
  } catch (e) {
    Logger.log('changePlan error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Look up the monthly dollar amount for a plan by querying its Stripe price.
 * Used when we need to record price for a customer without a live subscription.
 */
function getMonthlyAmountForPlan_(planName) {
  var priceId = getPriceIdForPlan_(planName);
  var price = stripeGet_('/v1/prices/' + priceId);
  return (price.unit_amount || 0) / 100;
}

// ── Payment History ────────────────────────────────────────

/**
 * Fetch the most recent invoices for a customer from Stripe.
 * Returns up to 20 invoices ordered newest first.
 */
function getCustomerPayments_(params) {
  var custId = params.id || '';
  if (!custId) return { error: 'missing_id' };

  try {
    var data = stripeGet_('/v1/invoices?customer=' + encodeURIComponent(custId) + '&limit=20');
    var invoices = (data.data || []).map(function(inv) {
      var st = inv.status_transitions || {};
      return {
        id: inv.id,
        number: inv.number || '',
        status: inv.status,                    // draft, open, paid, void, uncollectible
        amount: (inv.amount_paid || 0) / 100,
        amountDue: (inv.amount_due || 0) / 100,
        currency: inv.currency || 'usd',
        created: (inv.created || 0) * 1000,
        paidAt: st.paid_at ? st.paid_at * 1000 : null,
        hostedUrl: inv.hosted_invoice_url || '',
        pdfUrl: inv.invoice_pdf || ''
      };
    });
    return { invoices: invoices };
  } catch (e) {
    Logger.log('getCustomerPayments error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

// ── Manual Lead Conversion ─────────────────────────────────

/**
 * Convert a lead to a customer for a payment taken outside Stripe Checkout
 * (cash, check, in-person card, etc).
 *
 * By default this also creates a Stripe subscription with
 * collection_method=send_invoice so the customer is tracked in the same
 * billing pipeline as card customers -- Stripe generates an open invoice
 * each cycle that the operator marks paid when cash/check is received.
 * Pass setup_billing="false" to skip subscription creation (sheet-only).
 *
 * Optional params:
 *   payment_method  -- recorded in notes (cash/check/stripe terminal/other)
 *   paid_amount     -- recorded in notes; if setup_billing is on and amount
 *                      is provided, also recorded as a paid Stripe invoice
 *                      so it shows up in Payment History
 *   setup_billing   -- "true" (default) to create the Stripe subscription
 */
function convertLeadManual_(params) {
  var rowNum = parseInt(params.row, 10);
  if (!rowNum || rowNum < 2) return { error: 'invalid_row' };

  var leadData = readRow_(TAB_LEADS, rowNum, LEADS_HEADERS.length);
  var fullName = leadData[L.FULL_NAME - 1];
  var email = leadData[L.EMAIL - 1];
  var phone = leadData[L.PHONE - 1];
  var address = leadData[L.ADDRESS - 1];
  var city = leadData[L.CITY - 1];
  var state = leadData[L.STATE - 1];
  var zip = leadData[L.ZIP - 1];
  var plan = leadData[L.PLAN - 1];
  var rowKey = leadData[L.ROW_KEY - 1];
  var stripeCustId = leadData[L.STRIPE_CUST_ID - 1] || '';

  if (!email || !plan) return { error: 'missing_lead_data', message: 'Lead is missing email or plan.' };

  // Check for existing customer by Stripe ID or email
  var existing = stripeCustId ? findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, stripeCustId) : null;
  if (!existing) existing = findRow_(TAB_CUSTOMERS, C_.EMAIL, email);
  if (existing) {
    return { error: 'already_customer', message: 'A customer record already exists for this email.' };
  }

  var setupBilling = String(params.setup_billing || 'true').toLowerCase() !== 'false';
  var paymentMethod = String(params.payment_method || 'manual').trim();
  var paidAmountStr = String(params.paid_amount || '').trim();
  var paidAmount = parseFloat(paidAmountStr) || 0;

  var fullAddress = [address, city, state, zip].filter(function(p) { return p; }).join(', ');

  // Stripe subscription bookkeeping (only set when setupBilling)
  var subId = '';
  var subStatus = 'active';
  var monthlyPrice = '';
  var initialInvoiceId = '';

  if (setupBilling) {
    // Need a Stripe customer record. Create one if the lead never had a
    // checkout session (rare -- public signup form always creates one first).
    if (!stripeCustId) {
      try {
        var cust = createOrGetStripeCustomer_({
          email: email,
          name: fullName,
          phone: phone,
          address: { line1: address, city: city, state: state, zip: zip }
        });
        stripeCustId = cust.id;
        // Also write back to the lead so future references match
        var leadSheet = getSheet_(TAB_LEADS);
        leadSheet.getRange(rowNum, L.STRIPE_CUST_ID).setValue(stripeCustId);
      } catch (e) {
        return { error: 'stripe_error', message: 'Could not create Stripe customer: ' + e.message };
      }
    }

    // Create the subscription with send_invoice so Stripe generates open
    // invoices each cycle instead of auto-charging a card. trial_period_days
    // matches the card flow -- the trial ends when install is marked
    // Completed (existing logic in updateInstall_).
    var daysUntilDue = parseInt(propOr('MANUAL_INVOICE_DAYS_UNTIL_DUE', '30'), 10);
    var trialDays = parseInt(propOr('MANUAL_TRIAL_DAYS', '30'), 10);
    var newPriceId;
    try { newPriceId = getPriceIdForPlan_(plan); }
    catch (e) { return { error: 'invalid_plan', message: e.message }; }

    try {
      var sub = stripeRequest_('/v1/subscriptions', 'post', {
        customer: stripeCustId,
        'items[0][price]': newPriceId,
        collection_method: 'send_invoice',
        days_until_due: String(daysUntilDue),
        trial_period_days: String(trialDays),
        'metadata[row_key]': rowKey,
        'metadata[email]': email,
        'metadata[plan]': plan,
        'metadata[billing_method]': 'manual',
        'metadata[payment_method]': paymentMethod
      });
      subId = sub.id;
      subStatus = sub.status || 'trialing';
      if (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price) {
        monthlyPrice = (sub.items.data[0].price.unit_amount || 0) / 100;
      }
    } catch (e) {
      return { error: 'stripe_error', message: 'Could not create subscription: ' + e.message };
    }

    // Optional: record the upfront cash/check payment as a paid Stripe
    // invoice so it appears in Payment History. Failure here is non-fatal
    // -- the subscription is already created.
    if (paidAmount > 0) {
      try {
        initialInvoiceId = recordOutOfBandPayment_(stripeCustId, paidAmount, 'Initial ' + paymentMethod + ' payment');
      } catch (e) {
        Logger.log('Could not record initial payment invoice (non-fatal): ' + e.message);
      }
    }
  } else {
    // Sheet-only path: just record the asserted price for MRR reporting
    try { monthlyPrice = getMonthlyAmountForPlan_(plan); }
    catch (e) { Logger.log('Could not fetch price: ' + e.message); }
  }

  var noteParts = ['Manually converted from lead (' + paymentMethod + ')'];
  if (paidAmountStr) noteParts.push('Initial payment: $' + paidAmountStr);
  if (setupBilling) noteParts.push('Stripe send_invoice subscription created (' + subId + ')');
  else noteParts.push('No Stripe subscription -- track billing externally');
  noteParts.push('Converted on ' + new Date().toLocaleDateString());

  ensureHeaders_(TAB_CUSTOMERS, CUSTOMERS_HEADERS);
  var customerRow = [
    stripeCustId,                  // Stripe Customer ID
    fullName,                       // Full Name
    email,                          // Email
    phone,                          // Phone
    fullAddress,                    // Service Address
    plan,                           // Plan
    subId,                          // Stripe Subscription ID
    subStatus,                      // Subscription Status
    monthlyPrice,                   // Monthly Price
    '',                             // Portal Link
    new Date(),                     // Signup Date
    new Date(),                     // Last Payment Date
    setupBilling ? 'manual_conversion_subscribed' : 'manual_conversion_sheet_only',
    rowKey,                         // Row Key
    noteParts.join(' | '),          // Notes
    setupBilling ? 'manual' : 'manual_sheet_only'  // Billing Method
  ];
  appendRow_(TAB_CUSTOMERS, customerRow);

  // Create install row (Pending) so it shows up in the install workflow
  ensureHeaders_(TAB_INSTALLS, INSTALLS_HEADERS);
  var installRow = [
    fullName,                                 // Customer Name
    email,                                     // Email
    fullAddress,                               // Service Address
    plan,                                      // Plan
    leadData[L.INSTALL_PREF - 1] || '',       // Requested Preference
    '',                                        // Scheduled Date
    '',                                        // Technician
    '',                                        // Equipment Assigned
    'Pending',                                 // Status
    '',                                        // Completion Date
    ''                                         // Notes
  ];
  appendRow_(TAB_INSTALLS, installRow);

  // Mark the lead as Paid
  var sheet = getSheet_(TAB_LEADS);
  sheet.getRange(rowNum, L.LEAD_STATUS).setValue('Paid');

  // Send the welcome email so the customer has confirmation
  try {
    sendWelcomeEmail_(email, fullName, plan);
  } catch (e) {
    Logger.log('Welcome email failed (non-fatal): ' + e.message);
  }

  return {
    success: true,
    subscriptionId: subId,
    initialInvoiceId: initialInvoiceId,
    billingMethod: setupBilling ? 'manual' : 'manual_sheet_only'
  };
}

/**
 * Record an out-of-band payment as a paid Stripe invoice. Used to capture
 * upfront cash/check payments so they appear in the customer's Payment
 * History alongside subscription invoices.
 *
 * Returns the created invoice ID.
 */
function recordOutOfBandPayment_(customerId, amount, description) {
  // Step 1: floating invoice item (not attached to a subscription)
  stripeRequest_('/v1/invoiceitems', 'post', {
    customer: customerId,
    amount: String(Math.round(amount * 100)),
    currency: 'usd',
    description: description || 'Manual payment'
  });

  // Step 2: create an invoice that pulls in the floating item
  var invoice = stripeRequest_('/v1/invoices', 'post', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: '1',
    auto_advance: 'false'
  });

  // Step 3: finalize so it's an actual invoice we can pay
  stripeRequest_('/v1/invoices/' + invoice.id + '/finalize', 'post', {});

  // Step 4: mark paid out of band
  stripeRequest_('/v1/invoices/' + invoice.id + '/pay', 'post', {
    paid_out_of_band: 'true'
  });

  return invoice.id;
}

// ── Mark Invoice Paid (for manual customers) ───────────────

/**
 * Mark a Stripe invoice as paid out-of-band. Used by the operator after
 * receiving cash/check for a manually-billed customer's recurring invoice.
 */
function markInvoicePaid_(params) {
  var invoiceId = params.invoice_id || '';
  if (!invoiceId) return { error: 'missing_invoice_id' };

  try {
    var invoice = stripeRequest_('/v1/invoices/' + invoiceId + '/pay', 'post', {
      paid_out_of_band: 'true'
    });

    // Optionally update the customer's Last Payment Date in the sheet
    var custId = invoice.customer;
    if (custId) {
      var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
      if (customerRow) {
        writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_PAYMENT, new Date());
        writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'invoice_marked_paid_manual');
      }
    }

    return { success: true, status: invoice.status };
  } catch (e) {
    Logger.log('markInvoicePaid error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

// ── Terminal Reader ────────────────────────────────────────

/**
 * Return reader status (online/offline) and basic info for the UI.
 */
function adminReaderStatus_() {
  try {
    var reader = getReaderInfo_();
    return {
      configured: true,
      id: reader.id,
      label: reader.label || '',
      status: reader.status,               // 'online' | 'offline'
      serial: reader.serial_number || '',
      deviceType: reader.device_type || '',
      action: reader.action || null        // in-progress action if any
    };
  } catch (e) {
    Logger.log('adminReaderStatus error: ' + e.message);
    // Most common cause is TERMINAL_READER_ID not set yet.
    return { configured: false, error: 'reader_error', message: e.message };
  }
}

/**
 * Push a charge to the reader. Used by both the per-customer "Charge with
 * Reader" button and the ad-hoc Quick Charge screen.
 * Params:
 *   amount       -- dollars (string or number, e.g. "75.00")
 *   description  -- required
 *   customer_id  -- optional; attaches the charge to a Stripe customer
 */
function adminReaderCharge_(params) {
  var dollars = parseFloat(params.amount);
  if (!dollars || dollars <= 0) {
    return { error: 'invalid_amount', message: 'Amount must be greater than 0.' };
  }
  var description = String(params.description || '').trim();
  if (!description) {
    return { error: 'missing_description', message: 'Description is required.' };
  }
  var amountCents = Math.round(dollars * 100);
  if (amountCents < 50) {
    return { error: 'invalid_amount', message: 'Minimum charge is $0.50.' };
  }

  var customerId = String(params.customer_id || '').trim();
  var metadata = { source: 'admin_portal_reader' };
  if (customerId) metadata.admin_customer_id = customerId;

  var requireConfirm = String(params.require_confirm || 'false').toLowerCase() === 'true';

  try {
    var result = chargeOnReader_({
      amountCents: amountCents,
      description: description,
      customerId: customerId || null,
      metadata: metadata,
      requireConfirm: requireConfirm
    });
    return {
      success: true,
      paymentIntentId: result.paymentIntentId,
      awaitingConfirm: !!result.awaitingConfirm,
      readerAction: result.readerAction || null
    };
  } catch (e) {
    Logger.log('adminReaderCharge error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Return the reader's current action status. Used by the frontend while
 * polling for the customer's Confirm/Cancel tap during the confirm-first
 * charge flow.
 */
function adminReaderActionStatus_() {
  try {
    var reader = getReaderInfo_();
    var action = reader.action || null;
    // Pull the selection value (if any) out of collect_inputs so the
    // frontend doesn't have to know the exact Stripe payload shape.
    var selection = null;
    if (action && action.type === 'collect_inputs' && action.collect_inputs) {
      var inputs = action.collect_inputs.inputs || [];
      // Stripe returns the customer's chosen choice id as `selection.id`
      // on the input object; `selection.choices[].id` is the definition.
      if (inputs[0] && inputs[0].selection && inputs[0].selection.id) {
        selection = inputs[0].selection.id;
      }
    }
    return {
      status: action ? action.status : null,     // in_progress | succeeded | failed | canceled | null
      type: action ? action.type : null,         // collect_inputs | process_payment_intent | null
      selection: selection,
      failureCode: action && action.failure_code ? action.failure_code : null,
      failureMessage: action && action.failure_message ? action.failure_message : null
    };
  } catch (e) {
    Logger.log('adminReaderActionStatus error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Kick off the actual card collection on a PaymentIntent that was created
 * earlier by the confirm flow. Called once the frontend sees the customer
 * hit Confirm.
 */
function adminReaderStartPayment_(params) {
  var pi = String(params.payment_intent_id || '').trim();
  if (!pi) return { error: 'missing_payment_intent_id' };
  try {
    var result = startPaymentOnReader_(pi);
    return { success: true, readerAction: result.action || null };
  } catch (e) {
    Logger.log('adminReaderStartPayment error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Cancel the reader's in-progress action (operator hit Cancel before the
 * customer paid).
 */
function adminReaderCancel_() {
  try {
    cancelReaderAction_();
    return { success: true };
  } catch (e) {
    Logger.log('adminReaderCancel error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Take a plan/product payment on the Terminal. Creates a finalized Stripe
 * invoice for the given price, then spins up a card_present PaymentIntent
 * for its amount and pushes a Confirm / Cancel prompt to the reader.
 *
 * On the frontend's side the usual waiting_confirm -> waiting -> success
 * state machine runs. Once the card captures, the frontend must call
 * admin_reader_finalize_product_charge so we mark the invoice paid and
 * update the customer's last payment date.
 *
 * Params:
 *   customer_id -- Stripe customer ID (required)
 *   price_id    -- Stripe price ID to bill (required)
 *   plan_label  -- human-readable plan name shown on the reader (optional)
 */
function adminReaderChargeProduct_(params) {
  var customerId = String(params.customer_id || '').trim();
  var planName = String(params.plan_name || '').trim();
  if (!customerId) return { error: 'missing_customer_id' };
  if (!planName) return { error: 'missing_plan_name' };

  var priceId;
  try {
    priceId = getPriceIdForPlan_(planName);
  } catch (e) {
    return { error: 'invalid_plan', message: e.message };
  }
  var planLabel = planName;

  var invoice;
  try {
    invoice = createProductInvoice_({ customerId: customerId, priceId: priceId });
  } catch (e) {
    Logger.log('createProductInvoice_ error: ' + e.message);
    return { error: 'stripe_error', message: 'Could not prepare invoice: ' + e.message };
  }

  var amountCents = parseInt(invoice.amount_due, 10);
  if (!amountCents || amountCents < 50) {
    return { error: 'invalid_amount', message: 'Invoice amount is not valid for a Terminal charge.' };
  }

  var description = planLabel
    ? (planLabel + ' — Invoice ' + (invoice.number || invoice.id))
    : ('Invoice ' + (invoice.number || invoice.id));

  try {
    var result = chargeOnReader_({
      amountCents: amountCents,
      description: description,
      customerId: customerId,
      requireConfirm: true,
      metadata: {
        source: 'admin_portal_reader',
        product_charge: 'true',
        invoice_id: invoice.id,
        plan_label: planLabel || ''
      }
    });
    return {
      success: true,
      paymentIntentId: result.paymentIntentId,
      awaitingConfirm: !!result.awaitingConfirm,
      readerAction: result.readerAction || null,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number || '',
      amount: amountCents / 100
    };
  } catch (e) {
    Logger.log('adminReaderChargeProduct_ error: ' + e.message);
    // Invoice was created; try to void it so we don't leave a stranded
    // unpaid invoice on the customer's account.
    try { stripeRequest_('/v1/invoices/' + invoice.id + '/void', 'post', {}); } catch (vErr) {}
    return { error: 'stripe_error', message: e.message };
  }
}

/**
 * Called by the frontend after the Terminal payment captures. Reads the
 * PaymentIntent's metadata to find the linked invoice, marks the invoice
 * paid out of band, and updates the customer's Last Payment Date.
 */
function adminReaderFinalizeProductCharge_(params) {
  var pi = String(params.payment_intent_id || '').trim();
  if (!pi) return { error: 'missing_payment_intent_id' };

  var intent;
  try {
    intent = getPaymentIntentStatus_(pi);
  } catch (e) {
    return { error: 'stripe_error', message: 'Could not read PaymentIntent: ' + e.message };
  }

  if (intent.status !== 'succeeded') {
    return { error: 'not_succeeded', message: 'PaymentIntent is not in succeeded state (got: ' + intent.status + ').' };
  }

  var metadata = intent.metadata || {};
  var invoiceId = metadata.invoice_id || '';
  if (!invoiceId) {
    return { error: 'missing_invoice_id', message: 'PaymentIntent has no linked invoice.' };
  }

  try {
    markInvoicePaidOutOfBand_(invoiceId);
  } catch (e) {
    Logger.log('markInvoicePaidOutOfBand_ error: ' + e.message);
    return { error: 'stripe_error', message: 'Could not mark invoice paid: ' + e.message };
  }

  // Update the Last Payment Date in the sheet if this customer is in it.
  try {
    var customerId = intent.customer || '';
    if (customerId) {
      var customerRow = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, customerId);
      if (customerRow) {
        writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_PAYMENT, new Date());
        writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'reader_plan_charge');
      }
    }
  } catch (e) {
    Logger.log('Post-charge sheet update failed (non-fatal): ' + e.message);
  }

  return { success: true, invoiceId: invoiceId };
}

/**
 * Poll a PaymentIntent's status. Admin UI calls this every couple of seconds
 * after pushing a charge so it knows when the customer has paid (or failed).
 */
function adminReaderPaymentStatus_(params) {
  var pi = String(params.payment_intent_id || '').trim();
  if (!pi) return { error: 'missing_payment_intent_id' };
  try {
    var intent = getPaymentIntentStatus_(pi);
    return {
      id: intent.id,
      status: intent.status,          // requires_payment_method | requires_confirmation | requires_action | processing | succeeded | canceled
      amount: (intent.amount || 0) / 100,
      lastError: intent.last_payment_error ? intent.last_payment_error.message : null
    };
  } catch (e) {
    Logger.log('adminReaderPaymentStatus error: ' + e.message);
    return { error: 'stripe_error', message: e.message };
  }
}
