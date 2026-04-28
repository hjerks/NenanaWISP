/**
 * Stripe.gs -- Stripe API helpers
 * NenanaWISP Billing Platform
 */

// ── Script Property Helper ─────────────────────────────────

/**
 * Get a script property by key. Throws if missing.
 */
function prop(key) {
  var val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('Missing script property: ' + key);
  return val;
}

/**
 * Get a script property by key, returning a default if missing.
 */
function propOr(key, defaultVal) {
  var val = PropertiesService.getScriptProperties().getProperty(key);
  return val || defaultVal;
}

/**
 * Returns 'live' or 'test' based on the Stripe secret key prefix. Used by
 * the admin portal to display a TEST MODE banner so operators don't confuse
 * sandbox actions with live ones. Auto-detected from STRIPE_SECRET_KEY so
 * no extra Script Property is needed.
 */
function getStripeMode_() {
  var key = propOr('STRIPE_SECRET_KEY', '');
  if (key.indexOf('sk_live_') === 0) return 'live';
  return 'test';
}

// ── Price ID Lookup ────────────────────────────────────────

/**
 * Map plan display name to Stripe Price ID.
 */
function getPriceIdForPlan_(planName) {
  var map = {
    'Residential 50/10 Mbps':  prop('PRICE_RES_50_10'),
    'Residential 100/20 Mbps': prop('PRICE_RES_100_20'),
    'Business 100/100 Mbps':   prop('PRICE_BUS_100_100')
  };
  var priceId = map[planName];
  if (!priceId) throw new Error('Unknown plan: ' + planName);
  return priceId;
}

// ── Core API Wrapper ───────────────────────────────────────

/**
 * Make an authenticated request to the Stripe API.
 * @param {string} path - API path (e.g., '/v1/customers')
 * @param {string} method - HTTP method
 * @param {Object} [payload] - Key-value payload (form-encoded)
 * @returns {Object} Parsed JSON response
 */
function stripeRequest_(path, method, payload) {
  var secret = prop('STRIPE_SECRET_KEY');
  var url = 'https://api.stripe.com' + path;
  var options = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + secret
    },
    muteHttpExceptions: true
  };

  if (payload && (method === 'post' || method === 'POST')) {
    options.contentType = 'application/x-www-form-urlencoded';
    options.payload = toFormEncoded_(payload);
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = JSON.parse(response.getContentText());

  if (code < 200 || code >= 300) {
    Logger.log('Stripe API error: ' + JSON.stringify(body));
    throw new Error('Stripe API error (' + code + '): ' + (body.error ? body.error.message : 'Unknown error'));
  }

  return body;
}

/**
 * Stripe GET request helper.
 */
function stripeGet_(path) {
  return stripeRequest_(path, 'get');
}

/**
 * Convert a flat or nested object to Stripe's form-encoded format.
 * Handles bracket notation: metadata[key] = value, line_items[0][price] = value
 */
function toFormEncoded_(obj, prefix) {
  var parts = [];
  for (var key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    var fullKey = prefix ? prefix + '[' + key + ']' : key;
    var val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      parts.push(toFormEncoded_(val, fullKey));
    } else if (Array.isArray(val)) {
      for (var i = 0; i < val.length; i++) {
        if (typeof val[i] === 'object') {
          parts.push(toFormEncoded_(val[i], fullKey + '[' + i + ']'));
        } else {
          parts.push(encodeURIComponent(fullKey + '[' + i + ']') + '=' + encodeURIComponent(val[i]));
        }
      }
    } else {
      parts.push(encodeURIComponent(fullKey) + '=' + encodeURIComponent(val));
    }
  }
  return parts.filter(function(p) { return p !== ''; }).join('&');
}

// ── Customer Operations ────────────────────────────────────

/**
 * Search for an existing Stripe customer by email, or create a new one.
 * @param {Object} data - { email, name, phone, address (object) }
 * @returns {Object} Stripe customer object
 */
function createOrGetStripeCustomer_(data) {
  // Search by email first
  var search = stripeGet_('/v1/customers?email=' + encodeURIComponent(data.email) + '&limit=1');
  if (search.data && search.data.length > 0) {
    return search.data[0];
  }

  var addr = data.address || {};
  var payload = {
    email: data.email,
    name: data.name,
    phone: data.phone || '',
    address: {
      line1: addr.line1 || '',
      city: addr.city || '',
      state: addr.state || '',
      postal_code: addr.zip || '',
      country: 'US'
    }
  };

  return stripeRequest_('/v1/customers', 'post', payload);
}

// ── Checkout Session ───────────────────────────────────────

/**
 * Create a Stripe Checkout Session for a subscription.
 * @param {Object} opts
 * @param {string} opts.customerId - Stripe customer ID (cus_...)
 * @param {string} opts.priceId - Stripe price ID (price_...)
 * @param {string} opts.rowKey - UUID for row matching
 * @param {string} opts.email - Customer email
 * @param {string} opts.planName - Display name of plan
 * @param {string} [opts.installFeePrice] - Optional one-time install fee price ID
 * @returns {Object} Checkout session object (contains .url)
 */
function createCheckoutSession_(opts) {
  var payload = {
    customer: opts.customerId,
    mode: 'subscription',
    'success_url': prop('SUCCESS_URL') + '?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': prop('CANCEL_URL'),
    'line_items[0][price]': opts.priceId,
    'line_items[0][quantity]': '1',
    'metadata[row_key]': opts.rowKey,
    'metadata[email]': opts.email,
    'metadata[plan]': opts.planName,
    'subscription_data[metadata][row_key]': opts.rowKey,
    'subscription_data[metadata][email]': opts.email,
    'subscription_data[metadata][plan]': opts.planName,
    // Start with a 30-day trial so customer isn't charged until install is complete.
    // The trial is ended early (triggering first charge) when install is marked "Completed".
    'subscription_data[trial_period_days]': '30',
    'payment_method_collection': 'always'
  };

  // Optional one-time installation fee
  if (opts.installFeePrice) {
    payload['line_items[1][price]'] = opts.installFeePrice;
    payload['line_items[1][quantity]'] = '1';
  }

  // Use flat payload format here since we have bracket notation keys
  var secret = prop('STRIPE_SECRET_KEY');
  var url = 'https://api.stripe.com/v1/checkout/sessions';
  var options = {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + secret },
    contentType: 'application/x-www-form-urlencoded',
    payload: payload, // UrlFetchApp handles flat object encoding
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = JSON.parse(response.getContentText());

  if (code < 200 || code >= 300) {
    Logger.log('Checkout session error: ' + JSON.stringify(body));
    throw new Error('Checkout session error: ' + (body.error ? body.error.message : 'Unknown'));
  }

  return body;
}

// ── Customer Portal ────────────────────────────────────────

/**
 * Create a Stripe Customer Portal session.
 * @param {string} customerId - Stripe customer ID
 * @returns {string} Portal session URL
 */
function createPortalSession_(customerId) {
  var payload = {
    customer: customerId,
    return_url: prop('PORTAL_RETURN_URL')
  };
  var session = stripeRequest_('/v1/billing_portal/sessions', 'post', payload);
  return session.url;
}

// ── Invoice Helpers ────────────────────────────────────────

/**
 * Add a one-time invoice item to a customer (e.g., late fee).
 * @param {string} customerId - Stripe customer ID
 * @param {number} amountCents - Amount in cents
 * @param {string} description - Line item description
 */
function addInvoiceItem_(customerId, amountCents, description) {
  var payload = {
    customer: customerId,
    amount: String(amountCents),
    currency: 'usd',
    description: description
  };
  return stripeRequest_('/v1/invoiceitems', 'post', payload);
}

// ── Terminal Reader ────────────────────────────────────────

/**
 * Push a payment to the Terminal reader.
 * Creates a card_present PaymentIntent and tells the reader to collect it.
 * @param {Object} opts
 * @param {number} opts.amountCents - Amount in cents (>= 50)
 * @param {string} opts.description - Description shown on the payment
 * @param {string} [opts.customerId] - Optional Stripe customer ID to link the charge to
 * @param {Object} [opts.metadata] - Optional metadata keys to attach
 * @returns {Object} { paymentIntentId, readerAction }
 */
function chargeOnReader_(opts) {
  var readerId = prop('TERMINAL_READER_ID');
  var amount = parseInt(opts.amountCents, 10);
  if (!amount || amount < 50) {
    throw new Error('Amount must be at least $0.50');
  }

  var intentPayload = {
    amount: String(amount),
    currency: 'usd',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    description: opts.description || 'Terminal charge'
  };
  if (opts.customerId) intentPayload.customer = opts.customerId;
  if (opts.metadata) {
    for (var k in opts.metadata) {
      if (opts.metadata.hasOwnProperty(k)) {
        intentPayload['metadata[' + k + ']'] = opts.metadata[k];
      }
    }
  }

  var intent = stripeRequest_('/v1/payment_intents', 'post', intentPayload);

  if (opts.requireConfirm) {
    // Customer-confirm flow: show a Confirm / Cancel prompt on the reader
    // with the description + amount. The actual process_payment_intent is
    // fired later (via startPaymentOnReader_) once the frontend polls and
    // sees the customer hit Confirm.
    var dollars = (amount / 100).toFixed(2);
    var inputsPayload = {
      'inputs[0][type]': 'selection',
      'inputs[0][required]': 'true',
      'inputs[0][custom_text][title]': 'Confirm Payment',
      'inputs[0][custom_text][description]': '$' + dollars + '\n' + (opts.description || 'Charge'),
      'inputs[0][selection][choices][0][style]': 'primary',
      'inputs[0][selection][choices][0][id]': 'confirm',
      'inputs[0][selection][choices][0][text]': 'Confirm',
      'inputs[0][selection][choices][1][style]': 'secondary',
      'inputs[0][selection][choices][1][id]': 'cancel',
      'inputs[0][selection][choices][1][text]': 'Cancel'
    };
    try {
      stripeRequest_(
        '/v1/terminal/readers/' + readerId + '/collect_inputs',
        'post',
        inputsPayload
      );
    } catch (inputErr) {
      // If collect_inputs is not supported on the account, fall back to the
      // simple flow so we don't strand a PaymentIntent with no reader action.
      Logger.log('collect_inputs failed -- falling back to direct charge: ' + inputErr.message);
      var fallback = stripeRequest_(
        '/v1/terminal/readers/' + readerId + '/process_payment_intent',
        'post',
        { payment_intent: intent.id }
      );
      return {
        paymentIntentId: intent.id,
        readerAction: fallback.action || null,
        awaitingConfirm: false
      };
    }
    return {
      paymentIntentId: intent.id,
      awaitingConfirm: true
    };
  }

  // Simple flow: show a cart display for a brief moment (mostly metadata at
  // this point since process_payment_intent takes over the screen), then
  // start collecting the card.
  try {
    stripeRequest_(
      '/v1/terminal/readers/' + readerId + '/set_reader_display',
      'post',
      {
        type: 'cart',
        'cart[currency]': 'usd',
        'cart[total]': String(amount),
        'cart[tax]': '0',
        'cart[line_items][0][description]': opts.description || 'Charge',
        'cart[line_items][0][amount]': String(amount),
        'cart[line_items][0][quantity]': '1'
      }
    );
  } catch (displayErr) {
    Logger.log('set_reader_display failed (non-fatal): ' + displayErr.message);
  }

  var result = stripeRequest_(
    '/v1/terminal/readers/' + readerId + '/process_payment_intent',
    'post',
    { payment_intent: intent.id }
  );

  return {
    paymentIntentId: intent.id,
    readerAction: result.action || null,
    awaitingConfirm: false
  };
}

/**
 * Fire process_payment_intent on a previously-created PaymentIntent. Used
 * by the confirm-then-pay flow after the customer hits the Confirm button
 * via collect_inputs.
 */
function startPaymentOnReader_(paymentIntentId) {
  var readerId = prop('TERMINAL_READER_ID');
  return stripeRequest_(
    '/v1/terminal/readers/' + readerId + '/process_payment_intent',
    'post',
    { payment_intent: paymentIntentId }
  );
}

/**
 * Cancel the reader's in-progress action (if any). Used when the operator
 * hits "Cancel" after pushing a payment.
 */
function cancelReaderAction_() {
  var readerId = prop('TERMINAL_READER_ID');
  try {
    return stripeRequest_(
      '/v1/terminal/readers/' + readerId + '/cancel_action',
      'post',
      {}
    );
  } catch (e) {
    Logger.log('cancelReaderAction error (often safe to ignore): ' + e.message);
    return null;
  }
}

/**
 * Get the reader's current status and any in-progress action.
 */
function getReaderInfo_() {
  var readerId = prop('TERMINAL_READER_ID');
  return stripeGet_('/v1/terminal/readers/' + readerId);
}

/**
 * Get the status of a PaymentIntent by ID. Used to poll from the admin UI
 * while the reader is collecting payment.
 */
function getPaymentIntentStatus_(paymentIntentId) {
  return stripeGet_('/v1/payment_intents/' + paymentIntentId);
}

/**
 * Capture a card on file via the Terminal reader -- no money moves, just
 * saves the card as a PaymentMethod attached to the customer for future
 * off-session charges (subscription trial-end, etc).
 *
 * Mirrors chargeOnReader_ but uses SetupIntent + process_setup_intent
 * instead of PaymentIntent + process_payment_intent.
 *
 * opts: { customerId, planLabel?, trialDays?, metadata? }
 * returns: { setupIntentId, awaitingConfirm, readerAction? }
 */
function setupIntentOnReader_(opts) {
  var readerId = prop('TERMINAL_READER_ID');

  var siPayload = {
    customer: opts.customerId,
    'payment_method_types[]': 'card_present',
    usage: 'off_session'
  };
  if (opts.metadata) {
    for (var k in opts.metadata) {
      if (opts.metadata.hasOwnProperty(k)) {
        siPayload['metadata[' + k + ']'] = opts.metadata[k];
      }
    }
  }
  var setupIntent = stripeRequest_('/v1/setup_intents', 'post', siPayload);

  // Show a Confirm/Cancel prompt before tap-to-pay so the customer knows
  // their card is being saved (no immediate charge). Mirrors the
  // requireConfirm path on chargeOnReader_.
  var trialDays = parseInt(opts.trialDays, 10) || 30;
  var inputsPayload = {
    'inputs[0][type]': 'selection',
    'inputs[0][required]': 'true',
    'inputs[0][custom_text][title]': 'Save Card on File',
    'inputs[0][custom_text][description]':
      (opts.planLabel ? opts.planLabel + '\n' : '') +
      'No charge today. First charge in ' + trialDays + ' days.',
    'inputs[0][selection][choices][0][style]': 'primary',
    'inputs[0][selection][choices][0][id]': 'confirm',
    'inputs[0][selection][choices][0][text]': 'Confirm',
    'inputs[0][selection][choices][1][style]': 'secondary',
    'inputs[0][selection][choices][1][id]': 'cancel',
    'inputs[0][selection][choices][1][text]': 'Cancel'
  };

  try {
    stripeRequest_(
      '/v1/terminal/readers/' + readerId + '/collect_inputs',
      'post',
      inputsPayload
    );
    return { setupIntentId: setupIntent.id, awaitingConfirm: true };
  } catch (inputErr) {
    Logger.log('collect_inputs failed -- falling back to direct setup_intent: ' + inputErr.message);
    var fallback = stripeRequest_(
      '/v1/terminal/readers/' + readerId + '/process_setup_intent',
      'post',
      {
        setup_intent: setupIntent.id,
        allow_redisplay: 'always'
      }
    );
    return {
      setupIntentId: setupIntent.id,
      readerAction: fallback.action || null,
      awaitingConfirm: false
    };
  }
}

/**
 * Fire process_setup_intent on a previously-created SetupIntent. Used
 * after the customer hits Confirm on the reader.
 *
 * `allow_redisplay=always` -- the saved card can be shown back to the
 * customer (card-on-file in the portal). Required top-level param on
 * this endpoint as of API version 2026-03-25.
 */
function startSetupIntentOnReader_(setupIntentId) {
  var readerId = prop('TERMINAL_READER_ID');
  return stripeRequest_(
    '/v1/terminal/readers/' + readerId + '/process_setup_intent',
    'post',
    {
      setup_intent: setupIntentId,
      allow_redisplay: 'always'
    }
  );
}

/**
 * Get the status of a SetupIntent by ID. Used by the frontend to poll
 * after pushing the setup_intent to the reader.
 */
function getSetupIntentStatus_(setupIntentId) {
  return stripeGet_('/v1/setup_intents/' + setupIntentId);
}

/**
 * Create a finalized one-off invoice for a specific Stripe product/price
 * and return the invoice object. The resulting invoice has a single line
 * item whose amount and description come from the Price on Stripe's side,
 * so the transaction in the dashboard shows the plan name and price
 * instead of a generic Terminal charge.
 *
 * The invoice is created with collection_method=send_invoice so Stripe
 * does not auto-attempt to charge any card on file -- we collect via the
 * Terminal and mark the invoice paid out of band once the tap succeeds.
 */
function createProductInvoice_(opts) {
  var customerId = opts.customerId;
  var priceId = opts.priceId;
  if (!customerId) throw new Error('Missing customerId for invoice');
  if (!priceId) throw new Error('Missing priceId for invoice');

  // Fetch the Price so we can copy its amount, currency, and product name
  // into the invoice item directly. We do this manually rather than passing
  // `price=price_xxx` to /v1/invoiceitems because that parameter was
  // deprecated in favor of a more structured shape, and letting Stripe
  // hydrate the item automatically has been inconsistent across API
  // versions.
  var price = stripeGet_('/v1/prices/' + priceId);
  var amountCents = parseInt(price.unit_amount, 10) || 0;
  var currency = price.currency || 'usd';

  if (!amountCents || amountCents < 50) {
    throw new Error(
      'Price ' + priceId + ' has no usable unit_amount. ' +
      'unit_amount=' + price.unit_amount +
      ', unit_amount_decimal=' + price.unit_amount_decimal +
      ', billing_scheme=' + price.billing_scheme +
      ', type=' + price.type +
      ', currency=' + price.currency +
      ', active=' + price.active
    );
  }

  // Grab the product name so the line item description says
  // "Residential 100/20 Mbps" instead of a bare price ID.
  var lineDescription = 'Plan payment';
  if (price.product) {
    try {
      var product = stripeGet_('/v1/products/' + price.product);
      if (product && product.name) lineDescription = product.name;
    } catch (e) {
      Logger.log('Could not fetch product for line description: ' + e.message);
    }
  }

  // 1. Create an empty draft invoice first so we can attach the line item
  //    directly to it. Doing it in this order avoids the "pending invoice
  //    items behavior" ambiguity for customers who also have an active
  //    subscription (which would otherwise leave our line item dangling).
  var invoice = stripeRequest_('/v1/invoices', 'post', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: '1',
    auto_advance: 'false',
    'metadata[stripe_price_id]': priceId,
    'metadata[stripe_product_id]': price.product || ''
  });

  // 2. Add the line item directly to this invoice by passing its ID.
  stripeRequest_('/v1/invoiceitems', 'post', {
    customer: customerId,
    invoice: invoice.id,
    amount: String(amountCents),
    currency: currency,
    description: lineDescription,
    'metadata[stripe_price_id]': priceId,
    'metadata[stripe_product_id]': price.product || ''
  });

  // 3. Finalize so the invoice is immutable and the amount_due is locked.
  invoice = stripeRequest_('/v1/invoices/' + invoice.id + '/finalize', 'post', {});

  return invoice;
}

/**
 * Mark an invoice paid out of band. Used after a Terminal payment has
 * captured so the invoice's paid state matches reality in Stripe.
 */
function markInvoicePaidOutOfBand_(invoiceId) {
  return stripeRequest_('/v1/invoices/' + invoiceId + '/pay', 'post', {
    paid_out_of_band: 'true'
  });
}

/**
 * One-shot manual test: push $1 to the reader. Run from the Apps Script
 * editor to sanity-check the TERMINAL_READER_ID script property.
 */
function testChargeReader() {
  var result = chargeOnReader_({
    amountCents: 100,
    description: 'Terminal test charge'
  });
  Logger.log('PaymentIntent: ' + result.paymentIntentId);
  Logger.log('Reader action: ' + JSON.stringify(result.readerAction));
  return result;
}

/**
 * Diagnostic: call collect_inputs directly and log exactly what Stripe
 * returns. Run this from the editor when the confirm-button flow is not
 * showing up on the reader, so we can see the actual error message.
 */
function testCollectInputs() {
  var readerId = prop('TERMINAL_READER_ID');
  var secret = prop('STRIPE_SECRET_KEY');
  var url = 'https://api.stripe.com/v1/terminal/readers/' + readerId + '/collect_inputs';

  var payload = {
    'inputs[0][type]': 'selection',
    'inputs[0][required]': 'true',
    'inputs[0][custom_text][title]': 'Confirm Payment',
    'inputs[0][custom_text][description]': '$1.00\nTest charge',
    'inputs[0][selection][choices][0][style]': 'primary',
    'inputs[0][selection][choices][0][id]': 'confirm',
    'inputs[0][selection][choices][0][text]': 'Confirm',
    'inputs[0][selection][choices][1][style]': 'secondary',
    'inputs[0][selection][choices][1][id]': 'cancel',
    'inputs[0][selection][choices][1][text]': 'Cancel'
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + secret },
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  Logger.log('HTTP ' + code);
  Logger.log(body);
  return { code: code, body: body };
}
