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

  // Create new customer
  var payload = {
    email: data.email,
    name: data.name,
    phone: data.phone || ''
  };

  if (data.address) {
    payload['address[line1]'] = data.address.line1 || '';
    payload['address[city]'] = data.address.city || '';
    payload['address[state]'] = data.address.state || '';
    payload['address[postal_code]'] = data.address.zip || '';
    payload['address[country]'] = 'US';
    // Use flat keys for address since toFormEncoded_ handles nested objects
    // but Stripe expects the flat bracket format for top-level
  }

  // Actually, let's use nested format which toFormEncoded_ handles correctly
  var createPayload = {
    email: data.email,
    name: data.name,
    phone: data.phone || '',
    address: {
      line1: data.address ? data.address.line1 : '',
      city: data.address ? data.address.city : '',
      state: data.address ? data.address.state : '',
      postal_code: data.address ? data.address.zip : '',
      country: 'US'
    }
  };

  return stripeRequest_('/v1/customers', 'post', createPayload);
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
