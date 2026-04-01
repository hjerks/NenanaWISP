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

  // Redirect back to admin page with token
  if (redirectUrl) {
    return HtmlService.createHtmlOutput(
      '<html><head><script>' +
      'window.location.href = "' + sanitize_(redirectUrl) + '#token=' + token + '";' +
      '</script></head><body><p>Redirecting...</p></body></html>'
    );
  }

  // If no redirect URL, return the token as JSON
  return ContentService.createTextOutput(
    JSON.stringify({ token: token, email: user, expires_in: TOKEN_EXPIRY_HOURS * 3600 })
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
        signupDate: c['Signup Date']
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
