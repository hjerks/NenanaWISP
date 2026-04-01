/**
 * Webhooks.gs -- Stripe webhook event processing
 * NenanaWISP Billing Platform
 */

/**
 * Handle incoming Stripe webhook events.
 * Called by doPost() when the request is not a signup form submission.
 */
function handleWebhook(e) {
  var raw = '';
  try {
    raw = e.postData ? e.postData.contents : '';
    if (!raw) {
      return ContentService.createTextOutput('no payload').setMimeType(ContentService.MimeType.TEXT);
    }

    var evt = JSON.parse(raw);

    // Log the event before processing
    logWebhookEvent_(evt, raw, 'received');

    // Process the event
    processStripeEvent_(evt);

    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    Logger.log('Webhook error: ' + err.message + '\n' + err.stack);
    // Log the error
    try {
      logWebhookEvent_(null, raw, 'error: ' + err.message);
    } catch (logErr) {
      Logger.log('Failed to log webhook error: ' + logErr.message);
    }
    // Return 200 to prevent Stripe from retrying (we logged the error)
    return ContentService.createTextOutput('error logged').setMimeType(ContentService.MimeType.TEXT);
  }
}

/**
 * Process a Stripe event based on its type.
 */
function processStripeEvent_(evt) {
  var type = evt.type;
  var obj = evt.data.object;

  switch (type) {
    case 'checkout.session.completed':
      handleCheckoutCompleted_(obj);
      break;
    case 'invoice.paid':
      handleInvoicePaid_(obj);
      break;
    case 'invoice.payment_failed':
      handleInvoicePaymentFailed_(obj);
      break;
    case 'customer.subscription.deleted':
      handleSubscriptionDeleted_(obj);
      break;
    case 'customer.subscription.updated':
      handleSubscriptionUpdated_(obj);
      break;
    default:
      Logger.log('Unhandled webhook event type: ' + type);
  }
}

// ── Event Handlers ─────────────────────────────────────────

/**
 * Handle checkout.session.completed -- customer finished paying.
 * 1. Find the lead row
 * 2. Update lead status to "Paid"
 * 3. Create customer row
 * 4. Create install row
 * 5. Send welcome email
 */
function handleCheckoutCompleted_(session) {
  var custId = session.customer;
  var email = session.customer_details ? session.customer_details.email : (session.customer_email || '');
  var metadata = session.metadata || {};
  var rowKey = metadata.row_key || '';
  var planName = metadata.plan || '';
  var subId = session.subscription || '';

  // Find the lead row
  var leadRow = findLeadRow_(rowKey, custId, email);
  if (!leadRow) {
    Logger.log('checkout.session.completed: Could not find lead row for ' + email + ' / ' + custId);
    logWebhookEvent_({ type: 'checkout.session.completed' }, '', 'error: lead row not found');
    return;
  }

  // Update lead status
  writeCell_(TAB_LEADS, leadRow, L.LEAD_STATUS, 'Paid');
  writeCell_(TAB_LEADS, leadRow, L.STRIPE_CUST_ID, custId);

  // Create customer row
  var customerRowNum = createCustomerFromLead_(leadRow, subId, 'active');

  // Generate and save portal link
  try {
    var portalUrl = createPortalSession_(custId);
    writeCell_(TAB_CUSTOMERS, customerRowNum, C_.PORTAL_LINK, portalUrl);
  } catch (portalErr) {
    Logger.log('Portal link generation failed: ' + portalErr.message);
  }

  // Create install row
  createInstallFromLead_(leadRow);

  // Send welcome email
  var leadData = readRow_(TAB_LEADS, leadRow, LEADS_HEADERS.length);
  var name = leadData[L.FULL_NAME - 1];
  var plan = planName || leadData[L.PLAN - 1];

  try {
    var portalForEmail = createPortalSession_(custId);
    sendWelcomeEmail_(email, name, plan, portalForEmail);
  } catch (emailErr) {
    Logger.log('Welcome email failed: ' + emailErr.message);
    // Try without portal link
    sendWelcomeEmail_(email, name, plan, '');
  }

  logWebhookEvent_({ type: 'checkout.session.completed', data: { object: session } }, '', 'processed');
}

/**
 * Handle invoice.paid -- recurring payment successful.
 */
function handleInvoicePaid_(invoice) {
  var custId = invoice.customer;
  var email = invoice.customer_email || '';
  var subId = invoice.subscription || '';

  // Skip the first invoice (already handled by checkout.session.completed)
  if (invoice.billing_reason === 'subscription_create') {
    Logger.log('invoice.paid: Skipping initial subscription invoice for ' + custId);
    return;
  }

  var customerRow = findCustomerRow_(custId, email);
  if (!customerRow) {
    Logger.log('invoice.paid: Could not find customer row for ' + custId);
    return;
  }

  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, 'active');
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_PAYMENT, new Date());
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'invoice.paid');
}

/**
 * Handle invoice.payment_failed -- payment attempt failed.
 */
function handleInvoicePaymentFailed_(invoice) {
  var custId = invoice.customer;
  var email = invoice.customer_email || '';

  var customerRow = findCustomerRow_(custId, email);
  if (!customerRow) {
    Logger.log('invoice.payment_failed: Could not find customer row for ' + custId);
    return;
  }

  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, 'past_due');
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'invoice.payment_failed');

  // Send payment failure email
  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var name = customerData[C_.FULL_NAME - 1];

  try {
    var portalUrl = createPortalSession_(custId);
    sendPaymentFailedEmail_(email, name, portalUrl);
  } catch (err) {
    Logger.log('Payment failed email error: ' + err.message);
    sendPaymentFailedEmail_(email, name, '');
  }
}

/**
 * Handle customer.subscription.deleted -- subscription canceled.
 */
function handleSubscriptionDeleted_(subscription) {
  var custId = subscription.customer;
  var metadata = subscription.metadata || {};
  var email = metadata.email || '';

  var customerRow = findCustomerRow_(custId, email);
  if (!customerRow) {
    Logger.log('subscription.deleted: Could not find customer row for ' + custId);
    return;
  }

  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, 'canceled');
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'customer.subscription.deleted');

  // Send cancellation email
  var customerData = readRow_(TAB_CUSTOMERS, customerRow, CUSTOMERS_HEADERS.length);
  var name = customerData[C_.FULL_NAME - 1];
  var customerEmail = customerData[C_.EMAIL - 1];

  sendCancellationEmail_(customerEmail, name);
}

/**
 * Handle customer.subscription.updated -- plan change, status change, etc.
 */
function handleSubscriptionUpdated_(subscription) {
  var custId = subscription.customer;
  var metadata = subscription.metadata || {};
  var email = metadata.email || '';
  var newStatus = subscription.status;

  var customerRow = findCustomerRow_(custId, email);
  if (!customerRow) {
    Logger.log('subscription.updated: Could not find customer row for ' + custId);
    return;
  }

  writeCell_(TAB_CUSTOMERS, customerRow, C_.SUB_STATUS, newStatus);
  writeCell_(TAB_CUSTOMERS, customerRow, C_.LAST_EVENT, 'customer.subscription.updated');
}

// ── Webhook Logging ────────────────────────────────────────

/**
 * Log a webhook event to the Webhook_Log tab.
 */
function logWebhookEvent_(evt, raw, status) {
  ensureHeaders_(TAB_WEBHOOK_LOG, WEBHOOK_LOG_HEADERS);

  var eventType = '';
  var custId = '';
  var email = '';
  var subId = '';
  var rowKey = '';

  if (evt) {
    eventType = evt.type || '';
    var obj = evt.data ? evt.data.object : {};
    custId = obj.customer || '';
    email = obj.customer_email || (obj.customer_details ? obj.customer_details.email : '') || '';
    subId = obj.subscription || obj.id || '';
    var meta = obj.metadata || {};
    rowKey = meta.row_key || '';
  }

  var preview = String(raw || '').substring(0, 500);

  appendRow_(TAB_WEBHOOK_LOG, [
    new Date(),
    eventType,
    custId,
    email,
    subId,
    rowKey,
    status,
    preview
  ]);
}

// ── Auto-Suspension Check (Time-Driven Trigger) ───────────

/**
 * Check for past-due customers and send escalating warnings.
 * Set this up as a daily time-driven trigger in Apps Script.
 *
 * To install: Run setupDailyTrigger() once, or manually add via
 * Apps Script > Triggers > Add Trigger > checkPastDueCustomers > Day timer > 9am-10am
 */
function checkPastDueCustomers() {
  var customers = getDataAsObjects_(TAB_CUSTOMERS);
  var now = new Date();
  var lateFeeAmountCents = parseInt(propOr('LATE_FEE_AMOUNT_CENTS', '1000'), 10);
  var graceDay = parseInt(propOr('LATE_FEE_GRACE_DAYS', '7'), 10);

  for (var i = 0; i < customers.length; i++) {
    var cust = customers[i];
    if (cust['Subscription Status'] !== 'past_due') continue;

    var lastPayment = cust['Last Payment Date'];
    if (!lastPayment) continue;

    var lastPayDate = new Date(lastPayment);
    var daysPastDue = Math.floor((now - lastPayDate) / (1000 * 60 * 60 * 24));

    // Only send warnings at specific intervals to avoid spamming
    if (daysPastDue === 3 || daysPastDue === 7 || daysPastDue === 14) {
      var email = cust['Email'];
      var name = cust['Full Name'];
      var custId = cust['Stripe Customer ID'];

      try {
        var portalUrl = createPortalSession_(custId);
        sendSuspensionWarningEmail_(email, name, daysPastDue, portalUrl);
        Logger.log('Sent ' + daysPastDue + '-day warning to ' + email);
      } catch (err) {
        Logger.log('Suspension warning failed for ' + email + ': ' + err.message);
      }

      // Apply late fee at grace period
      if (daysPastDue === graceDay) {
        try {
          addInvoiceItem_(custId, lateFeeAmountCents, 'Late payment fee');
          Logger.log('Applied late fee to ' + email);
        } catch (feeErr) {
          Logger.log('Late fee failed for ' + email + ': ' + feeErr.message);
        }
      }
    }
  }
}

/**
 * Set up the daily trigger for past-due checks.
 * Run this function once manually from the Apps Script editor.
 */
function setupDailyTrigger() {
  // Remove any existing triggers for this function
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkPastDueCustomers') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Create new daily trigger at 9 AM
  ScriptApp.newTrigger('checkPastDueCustomers')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
  Logger.log('Daily past-due check trigger created (9 AM)');
}
