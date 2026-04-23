/**
 * Email.gs -- Email templates for customer communications
 * NenanaWISP Billing Platform
 */

// ── Shared Email Wrapper ───────────────────────────────────

/**
 * Build a complete HTML email with consistent branding.
 * @param {string} bodyContent - Inner HTML content
 * @returns {string} Complete HTML email
 */
function buildEmailHtml_(bodyContent) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var contactEmail = propOr('CONTACT_EMAIL', '');
  var contactPhone = propOr('CONTACT_PHONE', '');

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">' +

    // Header
    '<tr><td style="background-color:#1a5276;padding:24px 32px;text-align:center;">' +
    '<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:bold;">' + sanitize_(fromName) + '</h1>' +
    '<p style="margin:4px 0 0;color:#aed6f1;font-size:13px;">Community Broadband for Nenana</p>' +
    '</td></tr>' +

    // Body
    '<tr><td style="padding:32px;">' +
    bodyContent +
    '</td></tr>' +

    // Footer
    '<tr><td style="background-color:#f8f9fa;padding:20px 32px;border-top:1px solid #e5e7eb;">' +
    '<p style="margin:0;color:#6b7280;font-size:12px;text-align:center;">' +
    sanitize_(fromName) +
    (contactPhone ? ' &bull; ' + sanitize_(contactPhone) : '') +
    (contactEmail ? ' &bull; ' + sanitize_(contactEmail) : '') +
    '</p>' +
    '<p style="margin:4px 0 0;color:#9ca3af;font-size:11px;text-align:center;">Nenana, Alaska</p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

/**
 * Create a styled button for emails.
 */
function emailButton_(text, url) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">' +
    '<tr><td style="background-color:#2e86c1;border-radius:6px;">' +
    '<a href="' + url + '" target="_blank" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;">' +
    sanitize_(text) + '</a>' +
    '</td></tr></table>';
}

// ── Checkout Email ─────────────────────────────────────────

/**
 * Send the initial checkout/payment link email.
 */
function sendCheckoutEmail_(email, name, checkoutUrl, portalUrl, planName) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">Complete Your Signup</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Thank you for choosing ' + sanitize_(fromName) + '! ' +
    'You selected the <strong>' + sanitize_(planName) + '</strong> plan.</p>' +
    '<p style="color:#374151;line-height:1.6;">Click the button below to complete your signup and start service:</p>' +
    emailButton_('Complete Signup & Pay', checkoutUrl) +
    '<p style="color:#6b7280;font-size:13px;">This link will take you to our secure payment page powered by Stripe. ' +
    'Your payment information is never stored on our servers.</p>' +
    (portalUrl ?
      '<p style="color:#6b7280;font-size:13px;margin-top:20px;">You can also ' +
      '<a href="' + portalUrl + '" style="color:#2e86c1;">manage your account</a> ' +
      'at any time to update payment methods or view invoices.</p>'
      : '') +
    '<p style="color:#374151;line-height:1.6;margin-top:20px;">After payment, we\'ll reach out to schedule your installation. ' +
    'If you have any questions, just reply to this email.</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Complete your ' + fromName + ' signup',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Welcome Email ──────────────────────────────────────────

/**
 * Send welcome email after successful checkout.
 */
function sendWelcomeEmail_(email, name, planName, portalUrl) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var contactPhone = propOr('CONTACT_PHONE', '');

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">Welcome to ' + sanitize_(fromName) + '!</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Your payment has been received and your <strong>' +
    sanitize_(planName) + '</strong> subscription is now active. Welcome aboard!</p>' +

    '<div style="background-color:#f0f9ff;border-left:4px solid #2e86c1;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<h3 style="margin:0 0 8px;color:#1a5276;">What happens next?</h3>' +
    '<ul style="margin:0;padding:0 0 0 20px;color:#374151;line-height:1.8;">' +
    '<li>We\'ll contact you to schedule your equipment installation</li>' +
    '<li>Installation typically takes 1-2 hours</li>' +
    '<li>Your card won\'t be charged until your installation is complete</li>' +
    '<li>Monthly billing begins on your installation date</li>' +
    '</ul></div>' +

    (portalUrl ?
      '<p style="color:#374151;line-height:1.6;">You can manage your account, update payment methods, and view invoices anytime:</p>' +
      emailButton_('Manage My Account', portalUrl)
      : '') +

    '<p style="color:#374151;line-height:1.6;">Questions? Just reply to this email' +
    (contactPhone ? ' or call us at ' + sanitize_(contactPhone) : '') + '.</p>' +
    '<p style="color:#374151;line-height:1.6;">Thanks for being part of ' + sanitize_(fromName) + '!</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Welcome to ' + fromName + '!',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Payment Failed Email ───────────────────────────────────

/**
 * Send payment failure notification.
 */
function sendPaymentFailedEmail_(email, name, portalUrl) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var contactPhone = propOr('CONTACT_PHONE', '');

  var body =
    '<h2 style="margin:0 0 16px;color:#c0392b;">Payment Issue</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">We were unable to process your latest payment for your ' +
    sanitize_(fromName) + ' internet service.</p>' +

    '<div style="background-color:#fef2f2;border-left:4px solid #c0392b;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<p style="margin:0;color:#7f1d1d;">Please update your payment method as soon as possible to avoid service interruption.</p>' +
    '</div>' +

    (portalUrl ?
      '<p style="color:#374151;line-height:1.6;">Update your payment method here:</p>' +
      emailButton_('Update Payment Method', portalUrl)
      : '') +

    '<p style="color:#374151;line-height:1.6;">If you believe this is an error, please reply to this email' +
    (contactPhone ? ' or call ' + sanitize_(contactPhone) : '') + '.</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Action needed: Payment issue with your ' + fromName + ' account',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Cancellation Email ─────────────────────────────────────

/**
 * Send cancellation confirmation.
 */
function sendCancellationEmail_(email, name) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var contactEmail = propOr('CONTACT_EMAIL', '');

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">Subscription Canceled</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Your ' + sanitize_(fromName) +
    ' internet subscription has been canceled.</p>' +
    '<p style="color:#374151;line-height:1.6;">If this was a mistake or you\'d like to reactivate your service, ' +
    'please contact us' +
    (contactEmail ? ' at ' + sanitize_(contactEmail) : '') +
    ' and we\'ll be happy to help.</p>' +
    '<p style="color:#374151;line-height:1.6;margin-top:20px;">Thank you for being a customer. We hope to serve you again in the future.</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Your ' + fromName + ' subscription has been canceled',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Suspension Warning Emails ──────────────────────────────

/**
 * Send a past-due warning email with escalating urgency.
 * @param {string} email
 * @param {string} name
 * @param {number} daysPastDue
 * @param {string} portalUrl
 */
function sendSuspensionWarningEmail_(email, name, daysPastDue, portalUrl) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var contactPhone = propOr('CONTACT_PHONE', '');

  var urgency, subject, warningText, headerColor;

  if (daysPastDue <= 3) {
    urgency = 'reminder';
    subject = 'Payment reminder for your ' + fromName + ' account';
    headerColor = '#f39c12';
    warningText = 'Your account is past due. Please update your payment method to keep your service active.';
  } else if (daysPastDue <= 7) {
    urgency = 'warning';
    subject = 'Urgent: Your ' + fromName + ' account is past due';
    headerColor = '#e67e22';
    warningText = 'Your account is ' + daysPastDue + ' days past due. Service may be suspended if payment is not received soon.';
  } else {
    urgency = 'final';
    subject = 'Final notice: ' + fromName + ' service suspension';
    headerColor = '#c0392b';
    warningText = 'Your account is ' + daysPastDue + ' days past due. Your service will be suspended if payment is not received within 48 hours.';
  }

  var body =
    '<h2 style="margin:0 0 16px;color:' + headerColor + ';">Payment ' +
    (urgency === 'reminder' ? 'Reminder' : urgency === 'warning' ? 'Warning' : 'Final Notice') + '</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<div style="background-color:' + (urgency === 'final' ? '#fef2f2' : '#fffbeb') +
    ';border-left:4px solid ' + headerColor + ';padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<p style="margin:0;color:#374151;">' + warningText + '</p></div>' +
    (portalUrl ?
      '<p style="color:#374151;line-height:1.6;">Update your payment now:</p>' +
      emailButton_('Update Payment', portalUrl)
      : '') +
    '<p style="color:#374151;line-height:1.6;">If you\'ve already made a payment, please disregard this notice. ' +
    'For questions, reply to this email' +
    (contactPhone ? ' or call ' + sanitize_(contactPhone) : '') + '.</p>';

  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Service Suspension Email ───────────────────────────────

/**
 * Send notification that service has been suspended.
 */
function sendSuspensionNoticeEmail_(email, name) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var contactPhone = propOr('CONTACT_PHONE', '');
  var contactEmail = propOr('CONTACT_EMAIL', '');

  var body =
    '<h2 style="margin:0 0 16px;color:#c0392b;">Service Suspended</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<div style="background-color:#fef2f2;border-left:4px solid #c0392b;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<p style="margin:0;color:#7f1d1d;">Your ' + sanitize_(fromName) + ' internet service has been suspended due to non-payment.</p>' +
    '</div>' +
    '<p style="color:#374151;line-height:1.6;">To restore your service, please contact us to arrange payment:</p>' +
    '<ul style="color:#374151;line-height:1.8;">' +
    (contactEmail ? '<li>Email: ' + sanitize_(contactEmail) + '</li>' : '') +
    (contactPhone ? '<li>Phone: ' + sanitize_(contactPhone) + '</li>' : '') +
    '</ul>' +
    '<p style="color:#374151;line-height:1.6;">Once payment is received, your service will be restored promptly.</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Your ' + fromName + ' service has been suspended',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Service Reactivation Email ─────────────────────────────

/**
 * Send notification that service has been restored.
 */
function sendReactivationEmail_(email, name) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];

  var body =
    '<h2 style="margin:0 0 16px;color:#27ae60;">Service Restored</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<div style="background-color:#f0fdf4;border-left:4px solid #27ae60;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<p style="margin:0;color:#166534;">Your ' + sanitize_(fromName) + ' internet service has been restored. You should be back online now.</p>' +
    '</div>' +
    '<p style="color:#374151;line-height:1.6;">Thank you for resolving your account. If you experience any issues getting back online, please don\'t hesitate to contact us.</p>';

  MailApp.sendEmail({
    to: email,
    subject: 'Your ' + fromName + ' service has been restored',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Survey / Install Workflow Emails ───────────────────────

/**
 * Notify the network tech(s) that a new service request needs a site survey.
 * Recipients come from NETWORK_TECH_EMAILS (comma-separated) script property.
 */
function sendNewRequestTechEmail_(req) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var techEmails = propOr('NETWORK_TECH_EMAILS', '').split(',')
    .map(function(s) { return s.trim(); }).filter(Boolean);
  if (!techEmails.length) {
    Logger.log('NETWORK_TECH_EMAILS not configured; skipping tech notification');
    return;
  }

  var fullAddress = [req.address, req.city, req.state, req.zip].filter(Boolean).join(', ');
  var mapsUrl = req.lat && req.lon
    ? 'https://www.google.com/maps?q=' + req.lat + ',' + req.lon
    : 'https://www.google.com/maps/search/' + encodeURIComponent(fullAddress);

  var rows = [
    ['Customer', req.fullName],
    ['Email', req.email],
    ['Phone', req.phone || '(not provided)'],
    ['Plan', req.plan],
    ['Address', fullAddress],
    ['Coordinates', (req.lat && req.lon) ? (req.lat + ', ' + req.lon) : '(geocode failed)'],
    ['Requested install date', req.requestedInstallDate || 'ASAP'],
    ['Coverage prediction', req.coveragePrediction || '(not provided)'],
    ['Notes', req.notes || '(none)']
  ];
  var rowsHtml = rows.map(function(r) {
    return '<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;">' + sanitize_(r[0]) +
           '</td><td style="padding:6px 12px;color:#1f2937;font-size:14px;"><strong>' + sanitize_(r[1]) +
           '</strong></td></tr>';
  }).join('');

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">New Service Request</h2>' +
    '<p style="color:#374151;line-height:1.6;">A new request needs a site survey.</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8fafc;border-radius:6px;overflow:hidden;">' +
    rowsHtml +
    '</table>' +
    emailButton_('View Location on Google Maps', mapsUrl) +
    '<p style="color:#6b7280;font-size:13px;">Open the admin portal to approve the survey, propose a different install date, ' +
    'or mark as Cannot Install.</p>';

  MailApp.sendEmail({
    to: techEmails.join(','),
    subject: '[Survey Needed] ' + req.fullName + ' - ' + (req.address || 'no address'),
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: req.email
  });
}

/**
 * Confirmation to the customer that we received their request.
 */
function sendRequestReceivedEmail_(email, name, planName, requestedDate) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];
  var dateLine = requestedDate === 'ASAP'
    ? 'as soon as possible'
    : 'on or around ' + sanitize_(requestedDate);

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">We Got Your Request</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Thanks for requesting service with ' + sanitize_(fromName) + '. ' +
    'You picked the <strong>' + sanitize_(planName) + '</strong> plan and asked for installation ' + dateLine + '.</p>' +
    '<p style="color:#374151;line-height:1.6;">Our network tech will review the request, do a quick coverage check, ' +
    'and reach out within a day or two to confirm a date or let you know if we need to do a site survey first.</p>' +
    '<p style="color:#374151;line-height:1.6;"><strong>You won\'t be charged anything yet.</strong> ' +
    'Payment isn\'t collected until your install is complete.</p>' +
    '<p style="color:#6b7280;font-size:13px;margin-top:20px;">Questions? Just reply to this email.</p>';

  MailApp.sendEmail({
    to: email,
    subject: fromName + ': we got your request',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

/**
 * Notify the customer that the tech has approved their survey.
 */
function sendSurveyApprovedEmail_(email, name, planName, scheduledDate, message) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];

  var body =
    '<h2 style="margin:0 0 16px;color:#16a34a;">Install Date Confirmed</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Good news - your service request for the ' +
    '<strong>' + sanitize_(planName) + '</strong> plan has been approved.</p>' +
    '<div style="background-color:#f0fdf4;border-left:4px solid #16a34a;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
    '<p style="margin:0;color:#166534;font-size:15px;"><strong>Install scheduled for: ' + sanitize_(scheduledDate) + '</strong></p>' +
    '</div>' +
    (message ? '<p style="color:#374151;line-height:1.6;">' + sanitize_(message) + '</p>' : '') +
    '<p style="color:#374151;line-height:1.6;">No payment is needed yet - we\'ll send you a payment link once the install is complete.</p>' +
    '<p style="color:#6b7280;font-size:13px;margin-top:20px;">Need to reschedule? Just reply to this email.</p>';

  MailApp.sendEmail({
    to: email,
    subject: fromName + ': install scheduled for ' + scheduledDate,
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

/**
 * Notify the customer that we cannot install at their location.
 */
function sendSurveyRejectedEmail_(email, name, message) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];

  var body =
    '<h2 style="margin:0 0 16px;color:#1a5276;">About Your Service Request</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Thanks for reaching out to ' + sanitize_(fromName) + '. ' +
    'Unfortunately, after reviewing your location, we don\'t think we can deliver a reliable signal there right now.</p>' +
    (message
      ? '<div style="background-color:#fef3c7;border-left:4px solid #f59e0b;padding:16px;margin:20px 0;border-radius:0 6px 6px 0;">' +
        '<p style="margin:0;color:#92400e;">' + sanitize_(message) + '</p></div>'
      : '') +
    '<p style="color:#374151;line-height:1.6;">We\'ll keep your information on file. As we add more towers and capacity, ' +
    'we\'ll reach back out if your location becomes serviceable.</p>' +
    '<p style="color:#6b7280;font-size:13px;margin-top:20px;">Questions or want a second look? Reply to this email.</p>';

  MailApp.sendEmail({
    to: email,
    subject: fromName + ': about your service request',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}

// ── Broadcast email ────────────────────────────────────────

/**
 * Build the list of broadcast recipients - active customers only.
 * Returns array of { email, name, plan }.
 */
function getBroadcastRecipients_() {
  var customers = getDataAsObjects_(TAB_CUSTOMERS);
  return customers
    .filter(function(c) { return String(c['Subscription Status']).toLowerCase() === 'active'; })
    .map(function(c) {
      return {
        email: String(c['Email'] || '').trim(),
        name: String(c['Full Name'] || '').trim(),
        plan: String(c['Plan'] || '').trim()
      };
    })
    .filter(function(r) { return r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email); });
}

/**
 * Send a broadcast (e.g., outage notice) to all active customers.
 *
 * Safeguards:
 *   - Subject + body required, body min length
 *   - Hard-cap on recipient count (BROADCAST_MAX_RECIPIENTS)
 *   - Aborts if MailApp daily quota would be exceeded
 *   - Logs every send to Broadcast_Log
 *   - Per-message try/catch so one bounce doesn't kill the whole run
 *
 * Returns { ok, sent, failed, recipients, failedRecipients, error? }
 */
function sendBroadcast_(opts) {
  var subject = String(opts.subject || '').trim();
  var body = String(opts.body || '').trim();
  var senderEmail = String(opts.senderEmail || '').trim();
  if (!subject || subject.length < 3) return { error: 'subject_too_short' };
  if (!body || body.length < 10) return { error: 'body_too_short' };

  var recipients = getBroadcastRecipients_();
  if (!recipients.length) return { error: 'no_recipients' };

  var maxRecipients = parseInt(propOr('BROADCAST_MAX_RECIPIENTS', '200'), 10);
  if (recipients.length > maxRecipients) {
    return { error: 'too_many_recipients', count: recipients.length, max: maxRecipients };
  }

  var quotaLeft = MailApp.getRemainingDailyQuota();
  if (quotaLeft < recipients.length) {
    return { error: 'quota_exceeded', needed: recipients.length, available: quotaLeft };
  }

  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var replyTo = propOr('CONTACT_EMAIL', '');

  // Convert plain-text body to safe HTML: escape, then convert newlines to
  // paragraphs/breaks, then auto-link bare URLs.
  var bodyHtml = '<p style="color:#374151;line-height:1.6;white-space:pre-wrap;">' +
    autoLinkUrls_(sanitize_(body)) + '</p>';

  var sent = [];
  var failed = [];
  for (var i = 0; i < recipients.length; i++) {
    var r = recipients[i];
    var firstName = r.name.split(' ')[0] || 'there';
    var fullBody =
      '<h2 style="margin:0 0 16px;color:#1a5276;">' + sanitize_(subject) + '</h2>' +
      '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
      bodyHtml +
      '<p style="color:#6b7280;font-size:13px;margin-top:20px;">- The ' + sanitize_(fromName) + ' team</p>';

    try {
      MailApp.sendEmail({
        to: r.email,
        subject: subject,
        htmlBody: buildEmailHtml_(fullBody),
        name: fromName,
        replyTo: replyTo
      });
      sent.push(r.email);
    } catch (err) {
      Logger.log('Broadcast send failed for ' + r.email + ': ' + err.message);
      failed.push(r.email + ' (' + err.message + ')');
    }
  }

  // Log to Broadcast_Log
  try {
    ensureHeaders_(TAB_BROADCAST_LOG, BROADCAST_LOG_HEADERS);
    appendRow_(TAB_BROADCAST_LOG, [
      new Date(),
      senderEmail,
      subject,
      body,
      recipients.length,
      sent.length,
      failed.length,
      sent.join(', '),
      failed.join(', ')
    ]);
  } catch (logErr) {
    Logger.log('Broadcast log write failed: ' + logErr.message);
  }

  return {
    ok: true,
    sent: sent.length,
    failed: failed.length,
    recipients: recipients.length,
    failedRecipients: failed
  };
}

/**
 * Convert bare URLs in a string to <a> tags. Input MUST already be
 * HTML-escaped (this function does no further escaping on the URL text).
 */
function autoLinkUrls_(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, function(url) {
    return '<a href="' + url + '" style="color:#2e86c1;">' + url + '</a>';
  });
}

/**
 * Notify the customer that the install is complete and payment is now due.
 */
function sendInstallCompleteEmail_(email, name, planName, checkoutUrl) {
  var fromName = propOr('FROM_NAME', 'NNA Community Broadband');
  var firstName = name.split(' ')[0];

  var body =
    '<h2 style="margin:0 0 16px;color:#16a34a;">You\'re Online!</h2>' +
    '<p style="color:#374151;line-height:1.6;">Hi ' + sanitize_(firstName) + ',</p>' +
    '<p style="color:#374151;line-height:1.6;">Your ' + sanitize_(fromName) + ' install is complete and your ' +
    '<strong>' + sanitize_(planName) + '</strong> service is live.</p>' +
    '<p style="color:#374151;line-height:1.6;">To activate billing and keep service running, please complete payment using the button below. ' +
    'If you\'d rather pay in person with the tech, just let us know.</p>' +
    emailButton_('Complete Payment', checkoutUrl) +
    '<p style="color:#6b7280;font-size:13px;">Payment must be completed within 7 days to avoid service interruption.</p>' +
    '<p style="color:#6b7280;font-size:13px;margin-top:20px;">Welcome aboard!</p>';

  MailApp.sendEmail({
    to: email,
    subject: fromName + ': install complete - please complete payment',
    htmlBody: buildEmailHtml_(body),
    name: fromName,
    replyTo: propOr('CONTACT_EMAIL', '')
  });
}
