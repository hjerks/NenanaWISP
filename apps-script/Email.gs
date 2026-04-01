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
    '<li>Your monthly billing will begin automatically</li>' +
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
