/**
 * admin.js -- Admin portal logic for NenanaWISP
 *
 * Handles: authentication, view routing, data fetching, and rendering.
 *
 * CONFIGURATION: Set APPS_SCRIPT_URL to your deployed Apps Script web app URL.
 */

// ── Configuration ──────────────────────────────────────────
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwZV3Gljv5z5-RrOpM9eo3jDfQ7L_5E9fJYiDmISXli__tX_NWeW4i3zoGRxC08Ykr_4g/exec';

// Google OAuth 2.0 Client ID (Web application) from Google Cloud Console.
// This is the public client ID and is safe to commit -- the backend still
// verifies every ID token's audience against the same value stored in the
// Apps Script property GOOGLE_OAUTH_CLIENT_ID.
var GOOGLE_CLIENT_ID = '701479231557-u6v0bad9cj6ccsuo55d3o2l18f8q1fip.apps.googleusercontent.com';

// ── State ──────────────────────────────────────────────────
var adminToken = null;
var adminEmail = null;
var currentView = 'dashboard';
var cachedData = {};
var prefetchDone = false;
var refreshInterval = null;
var viewingCustomerId = null;

// ── Initialization ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  // Back-compat: older flow redirected with #token=... in the URL hash.
  var hash = window.location.hash;
  if (hash.indexOf('#token=') === 0) {
    adminToken = hash.substring(7);
    sessionStorage.setItem('adminToken', adminToken);
    window.location.hash = '';
  }

  if (!adminToken) {
    adminToken = sessionStorage.getItem('adminToken');
  }

  if (adminToken) {
    showApp();
    prefetchAllData();
  } else {
    initGoogleSignIn();
  }

  setupNav();
  setupKeyboardShortcuts();
});

// ── Authentication ─────────────────────────────────────────

/**
 * Render the Google Identity Services "Sign in with Google" button once
 * the GSI script has loaded. Called on DOMContentLoaded when the user has
 * no stored token.
 */
function initGoogleSignIn() {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE') {
    showAuthError('Admin portal OAuth is not yet configured. Set GOOGLE_CLIENT_ID in admin.js.');
    return;
  }

  var tries = 0;
  function waitForGsi() {
    if (window.google && google.accounts && google.accounts.id) {
      try {
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: onGoogleCredential,
          ux_mode: 'popup',
          auto_select: false
        });
        var btnContainer = document.getElementById('gsi-button');
        if (btnContainer) {
          btnContainer.innerHTML = '';
          google.accounts.id.renderButton(btnContainer, {
            type: 'standard',
            theme: 'filled_blue',
            size: 'large',
            text: 'signin_with',
            shape: 'pill'
          });
        }
      } catch (e) {
        showAuthError('Could not initialize Google Sign-In: ' + e.message);
      }
      return;
    }
    tries++;
    if (tries > 50) {
      showAuthError('Could not load Google Sign-In. Check your internet connection and try reloading.');
      return;
    }
    setTimeout(waitForGsi, 100);
  }
  waitForGsi();
}

/**
 * Called by Google Identity Services after the user selects an account.
 * response.credential is a JWT (ID token). We POST it to Apps Script for
 * server-side verification, and in return get our own signed admin token.
 */
function onGoogleCredential(response) {
  if (!response || !response.credential) {
    showAuthError('Sign-in failed: no credential returned.');
    return;
  }

  var authBtn = document.getElementById('auth-btn');
  if (authBtn) authBtn.disabled = true;

  var url = APPS_SCRIPT_URL + '?action=google_auth&id_token=' + encodeURIComponent(response.credential);
  fetch(url, { method: 'GET', redirect: 'follow' })
    .then(function(res) { return res.text(); })
    .then(function(text) {
      var data;
      try { data = JSON.parse(text); } catch (e) {
        showAuthError('Unexpected response from server. Try again in a moment.');
        return;
      }
      if (data.error) {
        showAuthError(data.message || data.error);
        return;
      }
      if (!data.token) {
        showAuthError('Server did not return a session token.');
        return;
      }
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      showApp();
      prefetchAllData();
    })
    .catch(function(err) {
      showAuthError('Sign-in request failed: ' + err.message);
    });
}

function logout() {
  adminToken = null;
  adminEmail = null;
  cachedData = {};
  sessionStorage.removeItem('adminToken');
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('admin-app').style.display = 'none';
  // Ask GSI to forget the previous sign-in so the button prompts for
  // account selection again rather than auto-signing back in.
  try {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
  } catch (e) {}
  initGoogleSignIn();
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('admin-app').style.display = '';
  // Decode email from token for display
  try {
    var payload = atob(adminToken.split('.')[0]);
    adminEmail = payload.substring(0, payload.lastIndexOf(':'));
    document.getElementById('user-email').textContent = adminEmail;
  } catch (e) {
    document.getElementById('user-email').textContent = '';
  }
  startReaderStatusPolling();
}

function showAuthError(msg) {
  var el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Prefetch ───────────────────────────────────────────────

var PREFETCH_ACTIONS = ['admin_dashboard', 'admin_customers', 'admin_leads', 'admin_installs', 'admin_equipment', 'admin_support'];

function prefetchAllData(silent) {
  if (!silent) {
    prefetchDone = false;
    var content = document.getElementById('content-area');
    content.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p id="prefetch-status">Loading data... 0/' + PREFETCH_ACTIONS.length + '</p></div>';
  }

  var completed = 0;
  var total = PREFETCH_ACTIONS.length;

  // Load sequentially -- first call warms up Apps Script, rest are fast
  function loadNext(index) {
    if (index >= total) {
      prefetchDone = true;
      if (!silent) renderCurrentView();
      updateRefreshStatus('Last updated: ' + new Date().toLocaleTimeString());
      return;
    }
    apiCall(PREFETCH_ACTIONS[index], null, function(err, data) {
      completed++;
      if (!silent) {
        var statusEl = document.getElementById('prefetch-status');
        if (statusEl) statusEl.textContent = 'Loading data... ' + completed + '/' + total;
        // Render dashboard as soon as it loads (first call)
        if (index === 0 && !prefetchDone) renderCurrentView();
      }
      loadNext(index + 1);
    });
  }
  loadNext(0);

  // Set up auto-refresh every 5 minutes
  if (!refreshInterval) {
    refreshInterval = setInterval(function() {
      prefetchAllData(true);
    }, 300000);
  }
}

function refreshData() {
  updateRefreshStatus('Refreshing...');
  prefetchAllData(false);
}

function updateRefreshStatus(text) {
  var el = document.getElementById('refresh-status');
  if (el) el.textContent = text;
}

function renderCurrentView() {
  if (viewingCustomerId) {
    viewCustomer(viewingCustomerId);
  } else {
    loadView(currentView);
  }
}

// ── API Calls ──────────────────────────────────────────────

function apiCall(action, params, callback, _retryCount) {
  if (!adminToken) { logout(); return; }
  var retryCount = _retryCount || 0;
  var maxRetries = 1;

  var url = APPS_SCRIPT_URL + '?action=' + action + '&token=' + encodeURIComponent(adminToken);
  if (params) {
    for (var key in params) {
      if (params.hasOwnProperty(key)) {
        url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      }
    }
  }

  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 25000);

  fetch(url, { signal: controller.signal, redirect: 'follow' })
    .then(function(res) {
      clearTimeout(timeoutId);
      if (!res.ok && retryCount < maxRetries) {
        throw new Error('HTTP ' + res.status);
      }
      return res.text();
    })
    .then(function(text) {
      try {
        var data = JSON.parse(text);
        if (data.error === 'unauthorized') {
          logout();
          showAuthError('Session expired. Please sign in again.');
          return;
        }
        cachedData[action] = { data: data, time: Date.now() };
        callback(null, data);
      } catch (e) {
        // Non-JSON response (Google error page) -- retry
        if (retryCount < maxRetries) {
          console.log('Retrying ' + action + ' (non-JSON response)');
          setTimeout(function() { apiCall(action, params, callback, retryCount + 1); }, 1500);
        } else if (cachedData[action] && (Date.now() - cachedData[action].time < 300000)) {
          callback(null, cachedData[action].data);
        } else {
          callback(new Error('Invalid response from server'), null);
        }
      }
    })
    .catch(function(err) {
      clearTimeout(timeoutId);
      // Auto-retry once on any failure
      if (retryCount < maxRetries) {
        console.log('Retrying ' + action + ' (' + err.message + ')');
        setTimeout(function() { apiCall(action, params, callback, retryCount + 1); }, 1500);
        return;
      }
      // After retry, fall back to cache
      if (cachedData[action] && (Date.now() - cachedData[action].time < 300000)) {
        callback(null, cachedData[action].data);
        return;
      }
      if (err.name === 'AbortError') {
        callback(new Error('Request timed out. Try again in a few seconds.'), null);
      } else {
        callback(err, null);
      }
    });
}

// ── Navigation ─────────────────────────────────────────────

function setupNav() {
  var links = document.querySelectorAll('[data-view]');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function(e) {
      e.preventDefault();
      var view = this.getAttribute('data-view');
      loadView(view);
      // Update active state
      var allLinks = document.querySelectorAll('[data-view]');
      for (var j = 0; j < allLinks.length; j++) allLinks[j].classList.remove('active');
      this.classList.add('active');
      // Close mobile sidebar
      document.getElementById('sidebar').classList.remove('open');
    });
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function(e) {
    var modalOpen = !!document.getElementById('modal-overlay');
    var inField = e.target && (
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.tagName === 'SELECT' ||
      e.target.isContentEditable
    );

    // Esc: close any open modal
    if (e.key === 'Escape' && modalOpen) {
      e.preventDefault();
      closeModal();
      return;
    }

    // Enter inside a modal (but not in textarea -- newline should still work):
    // click the primary action button. Works for both showModal and confirmModal.
    if (e.key === 'Enter' && modalOpen && e.target.tagName !== 'TEXTAREA') {
      var saveBtn = document.getElementById('modal-save-btn') || document.getElementById('confirm-ok-btn');
      if (saveBtn && !saveBtn.disabled) {
        e.preventDefault();
        saveBtn.click();
      }
      return;
    }

    // "/" focuses the search input on the customers view, only when not
    // already typing somewhere else.
    if (e.key === '/' && !inField && !modalOpen) {
      var search = document.getElementById('customer-search');
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
    }
  });
}

function loadView(view) {
  viewingCustomerId = null;
  currentView = view;
  var content = document.getElementById('content-area');
  var title = document.getElementById('page-title');

  // Show loading only if no cached data exists
  var actionMap = { dashboard: 'admin_dashboard', customers: 'admin_customers', leads: 'admin_leads', installs: 'admin_installs', equipment: 'admin_equipment', support: 'admin_support' };
  var hasCache = cachedData[actionMap[view]];
  if (!hasCache) {
    content.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading...</p></div>';
  }

  switch (view) {
    case 'dashboard':
      title.textContent = 'Dashboard';
      loadDashboard(content);
      break;
    case 'customers':
      title.textContent = 'Customers';
      loadCustomers(content, '');
      break;
    case 'leads':
      title.textContent = 'Leads';
      loadLeads(content);
      break;
    case 'installs':
      title.textContent = 'Installations';
      loadInstalls(content);
      break;
    case 'equipment':
      title.textContent = 'Equipment';
      loadEquipment(content);
      break;
    case 'support':
      title.textContent = 'Support Tickets';
      loadSupport(content);
      break;
    case 'quickcharge':
      title.textContent = 'Quick Charge';
      loadQuickCharge(content);
      break;
    default:
      content.innerHTML = '<div class="empty-state"><p>Unknown view</p></div>';
  }
}

/**
 * Get cached data or wait for prefetch to complete.
 * Only fetches directly if prefetch is done and cache is empty.
 */
function getCachedOrFetch(action, params, callback) {
  // If we have cached data, use it immediately
  if (cachedData[action]) {
    callback(null, cachedData[action].data);
    return;
  }
  // If prefetch is still running, wait for it
  if (!prefetchDone) {
    var checkInterval = setInterval(function() {
      if (cachedData[action]) {
        clearInterval(checkInterval);
        callback(null, cachedData[action].data);
      } else if (prefetchDone) {
        clearInterval(checkInterval);
        // Prefetch finished but this action isn't cached -- fetch directly
        apiCall(action, params, callback);
      }
    }, 200);
    return;
  }
  // Prefetch is done but no cache -- fetch directly
  apiCall(action, params, callback);
}

// ── Dashboard View ─────────────────────────────────────────

function loadDashboard(container) {
  getCachedOrFetch('admin_dashboard', null, function(err, data) {
    if (err || !data || !data.summary) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load dashboard data.</p><p style="margin-top:12px;"><button class="btn btn-primary" onclick="loadView(\'dashboard\')">Retry</button></p></div>';
      return;
    }
    var s = data.summary;
    var html = '';

    // Stats cards
    html += '<div class="stats-grid">';
    html += statCard('Active Subscribers', s.activeSubscribers, 'success');
    html += statCard('Past Due', s.pastDue, s.pastDue > 0 ? 'danger' : '');
    html += statCard('Monthly Revenue', formatMoney(s.mrr), 'success', true);
    html += statCard('Pending Leads', s.pendingLeads, s.pendingLeads > 0 ? 'warning' : '');
    html += '</div>';

    html += '<div class="stats-grid">';
    html += statCard('Pending Installs', s.pendingInstalls, s.pendingInstalls > 0 ? 'warning' : '');
    html += statCard('Open Tickets', s.openTickets, s.openTickets > 0 ? 'warning' : '');
    html += statCard('Canceled', s.canceled, '');
    html += statCard('Total (all time)', s.activeSubscribers + s.pastDue + s.canceled, '');
    html += '</div>';

    // Two column layout
    html += '<div class="two-col">';

    // Past due customers
    html += '<div class="panel">';
    html += '<div class="panel-header"><h2>Past Due Accounts</h2></div>';
    if (data.pastDueCustomers && data.pastDueCustomers.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Name</th><th>Plan</th><th>Last Payment</th></tr>';
      data.pastDueCustomers.forEach(function(c) {
        html += '<tr><td><a href="#" onclick="viewCustomer(\'' + esc(c.id) + '\');return false;" style="color:inherit;text-decoration:none;"><strong>' + esc(c.name) + '</strong></a><br><small style="color:#6b7280;">' + esc(c.email) + '</small></td>';
        html += '<td>' + esc(c.plan) + '</td>';
        html += '<td>' + formatDate(c.lastPayment) + '</td></tr>';
      });
      html += '</table></div>';
    } else {
      html += '<div class="panel-body"><div class="empty-state"><p>No past due accounts</p></div></div>';
    }
    html += '</div>';

    // Recent signups
    html += '<div class="panel">';
    html += '<div class="panel-header"><h2>Recent Signups (30 days)</h2></div>';
    if (data.recentSignups && data.recentSignups.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Name</th><th>Plan</th><th>Date</th></tr>';
      data.recentSignups.forEach(function(c) {
        html += '<tr><td><a href="#" onclick="viewCustomer(\'' + esc(c.id) + '\');return false;" style="color:var(--color-primary-light);cursor:pointer;">' + esc(c.name) + '</a></td><td>' + esc(c.plan) + '</td><td>' + formatDate(c.date) + '</td></tr>';
      });
      html += '</table></div>';
    } else {
      html += '<div class="panel-body"><div class="empty-state"><p>No recent signups</p></div></div>';
    }
    html += '</div>';

    html += '</div>'; // end two-col

    // Plan breakdown
    if (data.planBreakdown) {
      html += '<div class="panel">';
      html += '<div class="panel-header"><h2>Plan Breakdown (Active)</h2></div>';
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Plan</th><th>Count</th></tr>';
      for (var plan in data.planBreakdown) {
        html += '<tr><td>' + esc(plan) + '</td><td><strong>' + data.planBreakdown[plan] + '</strong></td></tr>';
      }
      html += '</table></div></div>';
    }

    container.innerHTML = html;
  });
}

function statCard(label, value, colorClass, isMoney) {
  return '<div class="stat-card ' + (colorClass || '') + '">' +
    '<div class="stat-label">' + label + '</div>' +
    '<div class="stat-value' + (isMoney ? ' money' : '') + '">' + value + '</div>' +
    '</div>';
}

// ── Customers View ─────────────────────────────────────────

function loadCustomers(container, search) {
  // Optional `search` arg (passed by older code paths) seeds the filter state
  // on first load so cross-view navigation can preserve a query.
  if (typeof search === 'string') filterState.customers.search = search;

  getCachedOrFetch('admin_customers', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load customers.</p><p style="margin-top:12px;"><button class="btn btn-primary" onclick="loadView(\'customers\')">Retry</button></p></div>';
      return;
    }

    var current = filterState.customers.search;
    var html = '';

    // Search bar -- now filters as you type, no Search button needed
    html += '<div class="panel"><div class="panel-body">';
    html += '<div class="search-bar">';
    html += '<input type="text" id="customer-search" placeholder="Filter by name, email, or address... (press / to focus)" value="' + esc(current) + '" oninput="onCustomerSearchInput(this.value)">';
    html += '</div></div></div>';

    // Table panel -- the table itself is in a separate div so we can
    // re-render it on filter/sort changes without losing input focus.
    html += '<div class="panel">';
    html += '<div class="panel-header"><h2 id="customers-count">Customers</h2><div class="btn-group"><button class="btn btn-sm btn-success" onclick="addCustomerManual()">+ New Customer</button><button class="btn btn-sm btn-outline" onclick="exportCustomers()">Export CSV</button></div></div>';
    html += renderFilterChips('customers', data.customers || [], function(r) { return r.status; });
    html += '<div id="customers-table-wrap"></div>';
    html += '</div>';

    container.innerHTML = html;
    refreshCustomersList();
  });
}

/**
 * Re-render only the customers table body and the count, applying current
 * search, status filter, and sort state from cached data. Preserves the
 * search input's focus + cursor position.
 */
function refreshCustomersList() {
  var wrap = document.getElementById('customers-table-wrap');
  var countEl = document.getElementById('customers-count');
  var cached = cachedData['admin_customers'] && cachedData['admin_customers'].data;
  if (!wrap || !cached) return;

  var rows = (cached.customers || []).slice();
  var f = filterState.customers;

  // Status filter
  if (f.status && f.status !== 'all') {
    rows = rows.filter(function(c) { return String(c.status || '') === f.status; });
  }
  // Search filter (client-side, instant)
  if (f.search) {
    var q = f.search.toLowerCase();
    rows = rows.filter(function(c) {
      return (c.name || '').toLowerCase().indexOf(q) !== -1 ||
             (c.email || '').toLowerCase().indexOf(q) !== -1 ||
             (c.address || '').toLowerCase().indexOf(q) !== -1;
    });
  }
  rows = applySort(rows, 'customers');

  // Save filtered set for CSV export
  window._lastCustomers = rows;

  if (countEl) countEl.textContent = 'Customers (' + rows.length + ')';

  // Refresh chip counts (counts always reflect the unfiltered total per status)
  // We need to re-render the chips bar too.
  var panel = wrap.parentElement;
  var existingChips = panel ? panel.querySelector('.filter-chips') : null;
  if (existingChips) {
    var chipHTML = renderFilterChips('customers', cached.customers || [], function(r) { return r.status; });
    var temp = document.createElement('div');
    temp.innerHTML = chipHTML;
    existingChips.replaceWith(temp.firstElementChild);
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="panel-body"><div class="empty-state"><p>No customers match the current filter.</p></div></div>';
    return;
  }

  var html = '<div class="panel-body no-pad"><table class="data-table">';
  html += '<tr>';
  html += sortableTh('customers', 'Name', 'name', 'text');
  html += sortableTh('customers', 'Email', 'email', 'text');
  html += sortableTh('customers', 'Plan', 'plan', 'text');
  html += sortableTh('customers', 'Status', 'status', 'text');
  html += sortableTh('customers', 'Last Payment', 'lastPayment', 'date');
  html += '<th></th></tr>';
  rows.forEach(function(c) {
    html += '<tr>';
    html += '<td><strong>' + esc(c.name) + '</strong></td>';
    html += '<td>' + esc(c.email) + '</td>';
    html += '<td>' + esc(c.plan) + '</td>';
    html += '<td>' + badge(c.status) + '</td>';
    html += '<td>' + formatDate(c.lastPayment) + '</td>';
    html += '<td><button class="btn btn-sm btn-primary" onclick="viewCustomer(\'' + esc(c.stripeCustomerId) + '\')">View</button></td>';
    html += '</tr>';
  });
  html += '</table></div>';
  wrap.innerHTML = html;
}

function onCustomerSearchInput(val) {
  filterState.customers.search = String(val || '').trim();
  refreshCustomersList();
}

// Kept for backwards compatibility -- now a no-op since search is instant.
function searchCustomers() {
  var inp = document.getElementById('customer-search');
  if (inp) onCustomerSearchInput(inp.value);
}

function viewCustomer(custId) {
  viewingCustomerId = custId;
  var content = document.getElementById('content-area');
  document.getElementById('page-title').textContent = 'Customer Detail';

  // Build customer detail from cached data (no separate API call needed)
  var customersData = cachedData['admin_customers'] ? cachedData['admin_customers'].data : null;
  var equipmentData = cachedData['admin_equipment'] ? cachedData['admin_equipment'].data : null;
  var supportData = cachedData['admin_support'] ? cachedData['admin_support'].data : null;
  var installsData = cachedData['admin_installs'] ? cachedData['admin_installs'].data : null;

  if (!customersData) {
    content.innerHTML = '<div class="empty-state"><p>Customer data not loaded yet.</p><p style="margin-top:12px;"><button class="btn btn-primary" onclick="refreshData()">Refresh Data</button> <button class="btn btn-outline" onclick="loadView(\'customers\')">Back</button></p></div>';
    return;
  }

  // Find the customer in cached data
  var c = null;
  var customers = customersData.customers || [];
  for (var i = 0; i < customers.length; i++) {
    if (customers[i].stripeCustomerId === custId) {
      c = customers[i];
      break;
    }
  }

  if (!c) {
    content.innerHTML = '<div class="empty-state"><p>Customer not found.</p><p style="margin-top:12px;"><button class="btn btn-outline" onclick="loadView(\'customers\')">Back</button></p></div>';
    return;
  }

  // Map customer list fields to detail format
  var customer = {
    'Stripe Customer ID': c.stripeCustomerId,
    'Full Name': c.name,
    'Email': c.email,
    'Phone': c.phone,
    'Service Address': c.address,
    'Plan': c.plan,
    'Subscription Status': c.status,
    'Last Payment Date': c.lastPayment,
    'Signup Date': c.signupDate,
    'Stripe Subscription ID': c.subscriptionId || '',
    'Monthly Price': c.monthlyPrice || '',
    'Portal Link': c.portalLink || '',
    'Last Event': c.lastEvent || '',
    'Notes': c.notes || '',
    'Billing Method': c.billingMethod || 'auto'
  };

  // Get related data from cache
  var custEmail = String(c.email || '').toLowerCase();
  var equipment = (equipmentData && equipmentData.equipment || []).filter(function(eq) {
    return String(eq['Assigned To'] || '').toLowerCase() === custEmail;
  });
  var tickets = (supportData && supportData.tickets || []).filter(function(t) {
    return String(t['Email'] || '').toLowerCase() === custEmail;
  });
  var installs = (installsData && installsData.installs || []).filter(function(inst) {
    return String(inst['Email'] || '').toLowerCase() === custEmail;
  });

  var data = { customer: customer, equipment: equipment, tickets: tickets, installs: installs };
  var c = data.customer;
  var html = '';

  var custIdEsc = esc(c['Stripe Customer ID']);
  var nameEscJs = esc(c['Full Name']).replace(/'/g, "\\'");
  var planEscJs = esc(c['Plan'] || '').replace(/'/g, "\\'");
  html += '<div class="action-bar">';
  html += '<button class="btn btn-sm btn-outline" onclick="loadView(\'customers\')">&larr; Back to Customers</button>';
  html += '<button class="btn btn-sm btn-primary" onclick="createTicket(\'' + nameEscJs + '\',\'' + esc(c['Email']).replace(/'/g, "\\'") + '\')">Create Ticket</button>';
  html += '<button class="btn btn-sm btn-success" onclick="chargeCustomerWithReader(\'' + custIdEsc + '\',\'' + nameEscJs + '\')">Charge with Reader</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="changePlan(\'' + custIdEsc + '\',\'' + nameEscJs + '\',\'' + planEscJs + '\')">Change Plan</button>';
  html += '<a class="btn btn-sm btn-outline" href="https://dashboard.stripe.com/customers/' + custIdEsc + '" target="_blank">Open in Stripe</a>';
  var subStatus = c['Subscription Status'];
  if (subStatus === 'active' || subStatus === 'past_due') {
    html += '<button class="btn btn-sm btn-danger" onclick="suspendCustomer(\'' + custIdEsc + '\', \'' + nameEscJs + '\')">Suspend Service</button>';
  } else if (subStatus === 'suspended') {
    html += '<button class="btn btn-sm btn-success" onclick="unsuspendCustomer(\'' + custIdEsc + '\', \'' + nameEscJs + '\')">Restore Service</button>';
  }
  html += '<button class="btn btn-sm btn-danger" onclick="deleteCustomer(\'' + custIdEsc + '\', \'' + nameEscJs + '\')">Delete</button>';
  html += '</div>';

  // Customer info
  html += '<div class="two-col">';
  html += '<div class="panel"><div class="panel-header"><h2>Customer Info</h2></div><div class="panel-body">';
  html += infoRow('Name', c['Full Name']);
  html += infoRow('Email', c['Email']);
  html += infoRow('Phone', c['Phone']);
  html += infoRow('Address', c['Service Address']);
  html += infoRow('Plan', c['Plan']);
  html += infoRow('Stripe ID', c['Stripe Customer ID']);
  html += '</div></div>';

  html += '<div class="panel"><div class="panel-header"><h2>Billing</h2></div><div class="panel-body">';
  var bm = c['Billing Method'];
  var bmDisplay;
  if (bm === 'manual') {
    bmDisplay = '<span class="badge badge-manual">Manual (Stripe send_invoice)</span>';
  } else if (bm === 'manual_sheet_only') {
    bmDisplay = '<span class="badge badge-manual">Manual (sheet only — no Stripe sub)</span>';
  } else {
    bmDisplay = '<span class="badge badge-auto">Auto (card on file)</span>';
  }
  html += infoRow('Billing Method', bmDisplay);
  html += infoRow('Status', badge(c['Subscription Status']));
  html += infoRow('Subscription ID', c['Stripe Subscription ID']);
  html += infoRow('Monthly Price', c['Monthly Price'] ? '$' + c['Monthly Price'] : '--');
  html += infoRow('Signup Date', formatDate(c['Signup Date']));
  html += infoRow('Last Payment', formatDate(c['Last Payment Date']));
  html += infoRow('Last Event', c['Last Event']);
  html += '</div></div>';
  html += '</div>';

  // Payment History (lazy-loaded from Stripe)
  html += '<div class="panel"><div class="panel-header"><h2>Payment History</h2><span style="font-size:0.78rem;color:#9ca3af;">Live from Stripe</span></div>';
  html += '<div id="payment-history" class="panel-body"><div class="loading"><div class="loading-spinner"></div><p>Loading payment history...</p></div></div>';
  html += '</div>';

  // Equipment
  html += '<div class="panel"><div class="panel-header"><h2>Equipment</h2></div>';
  if (data.equipment && data.equipment.length > 0) {
    html += '<div class="panel-body no-pad"><table class="data-table">';
    html += '<tr><th>Type</th><th>Make/Model</th><th>MAC</th><th>IP</th><th>Status</th></tr>';
    data.equipment.forEach(function(eq) {
      html += '<tr><td>' + esc(eq['Device Type']) + '</td><td>' + esc(eq['Make/Model']) + '</td>';
      html += '<td>' + esc(eq['MAC Address']) + '</td><td>' + esc(eq['IP Address']) + '</td>';
      html += '<td>' + badge(eq['Status']) + '</td></tr>';
    });
    html += '</table></div>';
  } else {
    html += '<div class="panel-body"><div class="empty-state"><p>No equipment assigned.</p></div></div>';
  }
  html += '</div>';

  // Support tickets
  html += '<div class="panel"><div class="panel-header"><h2>Support Tickets</h2></div>';
  if (data.tickets && data.tickets.length > 0) {
    html += '<div class="panel-body no-pad"><table class="data-table">';
    html += '<tr><th>Ticket</th><th>Date</th><th>Category</th><th>Status</th></tr>';
    data.tickets.forEach(function(t) {
      html += '<tr><td>' + esc(t['Ticket #']) + '</td><td>' + formatDate(t['Date Opened']) + '</td>';
      html += '<td>' + esc(t['Category']) + '</td><td>' + badge(t['Status']) + '</td></tr>';
    });
    html += '</table></div>';
  } else {
    html += '<div class="panel-body"><div class="empty-state"><p>No support tickets.</p></div></div>';
  }
  html += '</div>';

  // Install history
  html += '<div class="panel"><div class="panel-header"><h2>Installation</h2></div>';
  if (data.installs && data.installs.length > 0) {
    html += '<div class="panel-body no-pad"><table class="data-table">';
    html += '<tr><th>Requested</th><th>Scheduled</th><th>Technician</th><th>Status</th></tr>';
    data.installs.forEach(function(inst) {
      html += '<tr><td>' + esc(inst['Requested Preference']) + '</td>';
      html += '<td>' + formatDate(inst['Scheduled Date']) + '</td>';
      html += '<td>' + esc(inst['Technician']) + '</td>';
      html += '<td>' + badge(inst['Status']) + '</td></tr>';
    });
    html += '</table></div>';
  } else {
    html += '<div class="panel-body"><div class="empty-state"><p>No installation records.</p></div></div>';
  }
  html += '</div>';

  // Notes (editable)
  html += '<div class="panel"><div class="panel-header"><h2>Notes</h2></div>';
  html += '<div class="panel-body">';
  html += '<textarea id="customer-notes" data-cust-id="' + esc(custId) + '" data-original="' + esc(c['Notes'] || '') + '" style="width:100%;min-height:80px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-family:inherit;font-size:0.88rem;resize:vertical;" oninput="onNotesInput()" onblur="autoSaveNotes()">' + esc(c['Notes'] || '') + '</textarea>';
  html += '<div style="margin-top:8px;display:flex;align-items:center;gap:10px;">';
  html += '<button class="btn btn-sm btn-primary" id="save-notes-btn" onclick="saveCustomerNotes(\'' + esc(custId) + '\')">Save Notes</button>';
  html += '<span style="font-size:0.78rem;color:#9ca3af;">Auto-saves when you click away</span>';
  html += '</div></div></div>';

  content.innerHTML = html;

  // Lazy-load payment history from Stripe (slow API call, runs in background)
  loadPaymentHistory(custId);
}

// ── Plan Change ────────────────────────────────────────────

var PLAN_OPTIONS = [
  'Residential 50/10 Mbps',
  'Residential 100/20 Mbps',
  'Business 100/100 Mbps'
];

function changePlan(custId, name, currentPlan) {
  showModal('Change Plan for ' + name, [
    { label: 'Current Plan', type: 'static', value: currentPlan || '(none)' },
    { label: 'New Plan', key: 'plan', type: 'select', value: '', options: PLAN_OPTIONS },
    { label: 'Note', type: 'static', value: 'The Stripe subscription will be updated immediately with prorated charges/credits for the partial billing period.' }
  ], function(values) {
    if (!values.plan) return showModalMessage('error', 'Pick a new plan.');
    if (values.plan === currentPlan) return showModalMessage('error', 'That is already the current plan.');
    apiCall('admin_change_plan', { id: custId, plan: values.plan }, function(err, data) {
      if (err || !data || !data.success) {
        return showModalMessage('error', 'Failed: ' + (data ? (data.message || data.error) : err.message));
      }
      closeModal();
      toast('success', 'Plan changed to ' + values.plan);
      delete cachedData['admin_customers'];
      delete cachedData['admin_dashboard'];
      // Refresh customer detail with the new plan/price
      apiCall('admin_customers', null, function() { viewCustomer(custId); });
    });
  });
}

// ── Payment History ────────────────────────────────────────

var paymentHistoryCache = {};
var paymentHistoryCustId = null;  // tracks the customer whose history is on screen

function loadPaymentHistory(custId) {
  var el = document.getElementById('payment-history');
  if (!el) return;
  paymentHistoryCustId = custId;
  // Use cached result if it's recent (under 60s) so quick navigation
  // back-and-forth doesn't burn Stripe API quota
  var cached = paymentHistoryCache[custId];
  if (cached && (Date.now() - cached.time < 60000)) {
    renderPaymentHistory(cached.data);
    return;
  }
  apiCall('admin_customer_payments', { id: custId }, function(err, data) {
    // If the user navigated to a different customer mid-flight, drop result
    if (paymentHistoryCustId !== custId) return;
    if (err || !data || data.error) {
      var msg = err ? err.message : (data && (data.message || data.error)) || 'Could not load.';
      var elNow = document.getElementById('payment-history');
      if (elNow) {
        elNow.className = 'panel-body';
        elNow.innerHTML = '<div class="empty-state" style="padding:20px;"><p>Could not load payment history: ' + esc(msg) + '</p></div>';
      }
      return;
    }
    paymentHistoryCache[custId] = { data: data, time: Date.now() };
    renderPaymentHistory(data);
  });
}

function renderPaymentHistory(data) {
  var el = document.getElementById('payment-history');
  if (!el) return;
  var invoices = (data && data.invoices) || [];
  if (!invoices.length) {
    el.className = 'panel-body';
    el.innerHTML = '<div class="empty-state" style="padding:20px;"><p>No invoices yet.</p></div>';
    return;
  }
  el.className = 'panel-body no-pad';
  var html = '<table class="data-table">';
  html += '<tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Status</th><th></th></tr>';
  invoices.forEach(function(inv) {
    var amount = inv.status === 'paid' ? inv.amount : (inv.amountDue || inv.amount);
    html += '<tr>';
    html += '<td>' + formatDate(inv.created) + '</td>';
    html += '<td>' + esc(inv.number || inv.id) + '</td>';
    html += '<td>$' + Number(amount || 0).toFixed(2) + '</td>';
    html += '<td>' + badge(inv.status) + '</td>';
    html += '<td>';
    if (inv.status === 'open' || inv.status === 'past_due') {
      html += '<button class="btn btn-sm btn-success" onclick="markInvoicePaid(\'' + esc(inv.id) + '\', \'' + esc(inv.number || inv.id) + '\')">Mark Paid</button> ';
    }
    if (inv.hostedUrl) html += '<a class="btn btn-sm btn-outline" href="' + esc(inv.hostedUrl) + '" target="_blank">View</a> ';
    if (inv.pdfUrl) html += '<a class="btn btn-sm btn-outline" href="' + esc(inv.pdfUrl) + '" target="_blank">PDF</a>';
    html += '</td></tr>';
  });
  html += '</table>';
  el.innerHTML = html;
}

/**
 * Mark a Stripe invoice as paid out-of-band (operator received cash/check).
 * Confirms first because it can't be undone without going to Stripe.
 */
function markInvoicePaid(invoiceId, displayLabel) {
  var custId = paymentHistoryCustId;
  confirmModal({
    title: 'Mark invoice ' + displayLabel + ' as paid?',
    message: 'Records this invoice as paid out-of-band in Stripe (e.g., cash or check received). The customer\'s Last Payment Date will be updated. This cannot be undone from here -- you would need to refund or void the invoice in Stripe.',
    confirmText: 'Mark Paid',
    onConfirm: function(done) {
      apiCall('admin_mark_invoice_paid', { invoice_id: invoiceId }, function(err, data) {
        if (err || !data || !data.success) {
          done('Failed: ' + (data ? (data.message || data.error) : err.message));
          return;
        }
        done();
        toast('success', 'Invoice ' + displayLabel + ' marked paid');
        // Bust the per-customer cache and reload
        if (custId) delete paymentHistoryCache[custId];
        delete cachedData['admin_customers'];
        delete cachedData['admin_dashboard'];
        if (custId) loadPaymentHistory(custId);
      });
    }
  });
}

// ── Leads View ─────────────────────────────────────────────

function loadLeads(container) {
  getCachedOrFetch('admin_leads', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load leads.</p></div>';
      return;
    }
    // Filter out deleted leads
    var visibleLeads = (data.leads || []).filter(function(l) { return l['Lead Status'] !== 'Deleted'; });
    var html = '<div class="panel"><div class="panel-header"><h2>Leads (' + visibleLeads.length + ')</h2></div>';
    if (visibleLeads.length > 0) {
      var sortedLeads = applySort(visibleLeads, 'leads');
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr>';
      html += sortableTh('leads', 'Date', 'Timestamp', 'date');
      html += sortableTh('leads', 'Name', 'Full Name', 'text');
      html += sortableTh('leads', 'Email', 'Email', 'text');
      html += sortableTh('leads', 'Plan', 'Plan', 'text');
      html += sortableTh('leads', 'Status', 'Lead Status', 'text');
      html += '<th></th></tr>';
      sortedLeads.forEach(function(l) {
        html += '<tr>';
        html += '<td>' + formatDate(l['Timestamp']) + '</td>';
        html += '<td>' + esc(l['Full Name']) + '</td>';
        html += '<td>' + esc(l['Email']) + '</td>';
        html += '<td>' + esc(l['Plan']) + '</td>';
        html += '<td>' + badge(l['Lead Status']) + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-sm btn-outline" onclick=\'editLead(' + JSON.stringify(l) + ')\'>Edit</button>';
        if (l['Lead Status'] !== 'Paid') {
          html += '<button class="btn btn-sm btn-success" onclick=\'convertLeadManual(' + l._rowNum + ', ' + JSON.stringify(l['Full Name'] || '') + ')\'>Mark Paid</button>';
        }
        if (l['Lead Status'] === 'Checkout Sent') {
          html += '<button class="btn btn-sm btn-primary" onclick=\'resendCheckout(' + l._rowNum + ')\'>Resend</button>';
          if (l['Checkout Link']) {
            html += '<button class="btn btn-sm btn-outline" onclick=\'copyCheckoutLink("' + esc(l['Checkout Link']) + '")\'>Copy Link</button>';
          }
        }
        html += '</div></td>';
        html += '</tr>';
      });
      html += '</table></div>';
    } else {
      html += '<div class="panel-body"><div class="empty-state"><div class="icon">&#128203;</div><p>No leads yet.</p></div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  });
}

// ── Installs View ──────────────────────────────────────────

function loadInstalls(container) {
  getCachedOrFetch('admin_installs', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load installs.</p></div>';
      return;
    }
    var html = '<div class="panel">';
    html += '<div class="panel-header"><h2 id="installs-count">Installations</h2></div>';
    html += renderFilterChips('installs', data.installs || [], function(r) { return r['Status']; });
    html += '<div id="installs-table-wrap"></div>';
    html += '</div>';
    container.innerHTML = html;
    refreshInstallsList();
  });
}

function refreshInstallsList() {
  var wrap = document.getElementById('installs-table-wrap');
  var countEl = document.getElementById('installs-count');
  var cached = cachedData['admin_installs'] && cachedData['admin_installs'].data;
  if (!wrap || !cached) return;

  var rows = (cached.installs || []).slice();
  var f = filterState.installs;
  if (f.status && f.status !== 'all') {
    rows = rows.filter(function(r) { return String(r['Status'] || '') === f.status; });
  }
  rows = applySort(rows, 'installs');

  if (countEl) countEl.textContent = 'Installations (' + rows.length + ')';

  // Refresh chip counts
  var panel = wrap.parentElement;
  var existingChips = panel ? panel.querySelector('.filter-chips') : null;
  if (existingChips) {
    var chipHTML = renderFilterChips('installs', cached.installs || [], function(r) { return r['Status']; });
    var temp = document.createElement('div');
    temp.innerHTML = chipHTML;
    existingChips.replaceWith(temp.firstElementChild);
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="panel-body"><div class="empty-state"><div class="icon">&#128295;</div><p>No installations match the current filter.</p></div></div>';
    return;
  }

  var html = '<div class="panel-body no-pad"><table class="data-table">';
  html += '<tr>';
  html += sortableTh('installs', 'Customer', 'Customer Name', 'text');
  html += sortableTh('installs', 'Address', 'Service Address', 'text');
  html += sortableTh('installs', 'Plan', 'Plan', 'text');
  html += sortableTh('installs', 'Scheduled', 'Scheduled Date', 'date');
  html += sortableTh('installs', 'Technician', 'Technician', 'text');
  html += sortableTh('installs', 'Status', 'Status', 'text');
  html += '<th></th></tr>';
  rows.forEach(function(inst) {
    html += '<tr>';
    html += '<td><strong>' + esc(inst['Customer Name']) + '</strong><br><small style="color:#6b7280;">' + esc(inst['Email']) + '</small></td>';
    html += '<td>' + esc(inst['Service Address']) + '</td>';
    html += '<td>' + esc(inst['Plan']) + '</td>';
    html += '<td>' + formatDate(inst['Scheduled Date']) + '</td>';
    html += '<td>' + esc(inst['Technician']) + '</td>';
    html += '<td>' + badge(inst['Status']) + '</td>';
    html += '<td><button class="btn btn-sm btn-outline" onclick=\'editInstall(' + JSON.stringify(inst) + ')\'>Edit</button></td>';
    html += '</tr>';
  });
  html += '</table></div>';
  wrap.innerHTML = html;
}

function editInstall(inst) {
  showModal('Edit Installation', [
    { label: 'Customer', type: 'static', value: inst['Customer Name'] },
    { label: 'Scheduled Date', key: 'scheduled_date', type: 'date', value: formatDateInput(inst['Scheduled Date']) },
    { label: 'Technician', key: 'technician', type: 'text', value: inst['Technician'] },
    { label: 'Equipment Assigned', key: 'equipment', type: 'text', value: inst['Equipment Assigned'] },
    { label: 'Status', key: 'status', type: 'select', value: inst['Status'], options: ['Pending', 'Scheduled', 'In Progress', 'Completed', 'Canceled'] },
    { label: 'Completion Date', key: 'completion_date', type: 'date', value: formatDateInput(inst['Completion Date']) },
    { label: 'Notes', key: 'notes', type: 'textarea', value: inst['Notes'] }
  ], function(values) {
    values.row = inst._rowNum;
    apiCall('admin_update_install', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to save.'); }
      closeModal();
      delete cachedData['admin_installs'];
      delete cachedData['admin_dashboard'];
      delete cachedData['admin_customers'];
      loadView('installs');
    });
  });
}

// ── Equipment View ─────────────────────────────────────────

function loadEquipment(container) {
  getCachedOrFetch('admin_equipment', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load equipment.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>Equipment Inventory</h2><button class="btn btn-sm btn-success" onclick="addEquipment()">+ Add Equipment</button></div>';
    if (data.equipment && data.equipment.length > 0) {
      var sortedEquipment = applySort(data.equipment, 'equipment');
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr>';
      html += sortableTh('equipment', 'Type', 'Device Type', 'text');
      html += sortableTh('equipment', 'Make/Model', 'Make/Model', 'text');
      html += sortableTh('equipment', 'Serial', 'Serial Number', 'text');
      html += sortableTh('equipment', 'MAC', 'MAC Address', 'text');
      html += sortableTh('equipment', 'IP', 'IP Address', 'text');
      html += sortableTh('equipment', 'Assigned To', 'Assigned To', 'text');
      html += sortableTh('equipment', 'Status', 'Status', 'text');
      html += '<th></th></tr>';
      sortedEquipment.forEach(function(eq) {
        html += '<tr>';
        html += '<td>' + esc(eq['Device Type']) + '</td>';
        html += '<td>' + esc(eq['Make/Model']) + '</td>';
        html += '<td>' + esc(eq['Serial Number']) + '</td>';
        html += '<td><code>' + esc(eq['MAC Address']) + '</code></td>';
        html += '<td><code>' + esc(eq['IP Address']) + '</code></td>';
        html += '<td>' + esc(eq['Assigned To']) + '</td>';
        html += '<td>' + badge(eq['Status']) + '</td>';
        html += '<td><button class="btn btn-sm btn-outline" onclick=\'editEquipment(' + JSON.stringify(eq) + ')\'>Edit</button></td>';
        html += '</tr>';
      });
      html += '</table></div>';
    } else {
      html += '<div class="panel-body"><div class="empty-state"><div class="icon">&#128225;</div><p>No equipment in inventory.</p></div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  });
}

function equipmentFields(eq) {
  return [
    { label: 'Device Type', key: 'device_type', type: 'select', value: eq ? eq['Device Type'] : '', options: ['CPE', 'AP', 'Router', 'Switch', 'Other'] },
    { label: 'Make/Model', key: 'make_model', type: 'text', value: eq ? eq['Make/Model'] : '' },
    { label: 'Serial Number', key: 'serial', type: 'text', value: eq ? eq['Serial Number'] : '' },
    { label: 'MAC Address', key: 'mac', type: 'text', value: eq ? eq['MAC Address'] : '' },
    { label: 'IP Address', key: 'ip', type: 'text', value: eq ? eq['IP Address'] : '' },
    { label: 'VLAN', key: 'vlan', type: 'text', value: eq ? eq['VLAN'] : '' },
    { label: 'Assigned To', key: 'assigned_to', type: 'select', value: eq ? eq['Assigned To'] : '', options: customerEmailOptions() },
    { label: 'Location', key: 'location', type: 'text', value: eq ? eq['Location'] : '' },
    { label: 'Status', key: 'status', type: 'select', value: eq ? eq['Status'] : 'Available', options: ['Available', 'Deployed', 'RMA', 'Retired'] },
    { label: 'Notes', key: 'notes', type: 'textarea', value: eq ? eq['Notes'] : '' }
  ];
}

/**
 * Build dropdown options from cached customer list for equipment-assignment
 * fields. First option is "(Unassigned)" so equipment can be left unassigned
 * or freed from a customer. Sorted alphabetically by name.
 */
function customerEmailOptions() {
  var opts = [{ value: '', label: '(Unassigned)' }];
  var data = cachedData['admin_customers'] && cachedData['admin_customers'].data;
  if (!data || !data.customers) return opts;
  var customers = data.customers.slice().sort(function(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  customers.forEach(function(c) {
    if (c.email) opts.push({ value: c.email, label: (c.name || c.email) + ' \u2014 ' + c.email });
  });
  return opts;
}

function editEquipment(eq) {
  showModal('Edit Equipment', equipmentFields(eq), function(values) {
    values.row = eq._rowNum;
    apiCall('admin_update_equipment', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to save.'); }
      closeModal();
      loadView('equipment');
    });
  });
}

function addEquipment() {
  showModal('Add Equipment', equipmentFields(null), function(values) {
    apiCall('admin_create_equipment', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to save.'); }
      closeModal();
      loadView('equipment');
    });
  });
}

// ── Support View ───────────────────────────────────────────

function loadSupport(container) {
  getCachedOrFetch('admin_support', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load tickets.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>Support Tickets</h2><button class="btn btn-sm btn-success" onclick="createTicket()">+ New Ticket</button></div>';
    if (data.tickets && data.tickets.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Ticket</th><th>Customer</th><th>Date</th><th>Category</th><th>Description</th><th>Status</th><th></th></tr>';
      data.tickets.forEach(function(t) {
        html += '<tr>';
        html += '<td><strong>' + esc(t['Ticket #']) + '</strong></td>';
        html += '<td>' + esc(t['Customer Name']) + '<br><small style="color:#6b7280;">' + esc(t['Email']) + '</small></td>';
        html += '<td>' + formatDate(t['Date Opened']) + '</td>';
        html += '<td>' + esc(t['Category']) + '</td>';
        html += '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t['Description']) + '</td>';
        html += '<td>' + badge(t['Status']) + '</td>';
        html += '<td><button class="btn btn-sm btn-outline" onclick=\'editTicket(' + JSON.stringify(t) + ')\'>Edit</button></td>';
        html += '</tr>';
      });
      html += '</table></div>';
    } else {
      html += '<div class="panel-body"><div class="empty-state"><div class="icon">&#127919;</div><p>No support tickets.</p></div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  });
}

function editTicket(t) {
  showModal('Edit Ticket ' + t['Ticket #'], [
    { label: 'Customer', type: 'static', value: t['Customer Name'] + ' (' + t['Email'] + ')' },
    { label: 'Category', type: 'static', value: t['Category'] },
    { label: 'Description', type: 'static', value: t['Description'] },
    { label: 'Status', key: 'status', type: 'select', value: t['Status'], options: ['Open', 'In Progress', 'Resolved', 'Closed'] },
    { label: 'Resolution', key: 'resolution', type: 'textarea', value: t['Resolution'] },
    { label: 'Resolved Date', key: 'resolved_date', type: 'date', value: formatDateInput(t['Resolved Date']) },
    { label: 'Notes', key: 'notes', type: 'textarea', value: t['Notes'] }
  ], function(values) {
    values.row = t._rowNum;
    apiCall('admin_update_support', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to save.'); }
      closeModal();
      loadView('support');
    });
  });
}

function createTicket(prefillName, prefillEmail) {
  showModal('New Support Ticket', [
    { label: 'Customer Name', key: 'customer_name', type: 'text', value: prefillName || '' },
    { label: 'Email', key: 'email', type: 'text', value: prefillEmail || '' },
    { label: 'Category', key: 'category', type: 'select', value: '', options: ['Billing', 'Connectivity', 'Speed', 'Installation', 'Equipment', 'General'] },
    { label: 'Description', key: 'description', type: 'textarea', value: '' }
  ], function(values) {
    if (!values.customer_name || !values.email || !values.category || !values.description) {
      return showModalMessage('error', 'All fields are required.');
    }
    apiCall('admin_create_ticket', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to create ticket.'); }
      closeModal();
      loadView('support');
    });
  });
}

// ── Table Sorting ──────────────────────────────────────────

var sortState = {
  customers: { key: null, dir: 'asc', type: 'text' },
  leads: { key: null, dir: 'asc', type: 'text' },
  installs: { key: null, dir: 'asc', type: 'text' },
  equipment: { key: null, dir: 'asc', type: 'text' }
};

// Persistent filter state per view. status='all' means no status filter.
var filterState = {
  customers: { search: '', status: 'all' },
  installs: { status: 'all' }
};

// Status options for the filter chips. Order is what shows in the UI.
var STATUS_OPTIONS = {
  customers: [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'past_due', label: 'Past Due' },
    { value: 'suspended', label: 'Suspended' },
    { value: 'canceled', label: 'Canceled' }
  ],
  installs: [
    { value: 'all', label: 'All' },
    { value: 'Pending', label: 'Pending' },
    { value: 'Scheduled', label: 'Scheduled' },
    { value: 'In Progress', label: 'In Progress' },
    { value: 'Completed', label: 'Completed' },
    { value: 'Canceled', label: 'Canceled' }
  ]
};

/**
 * Render the filter-chips bar for a view. `getStatus` extracts the status
 * field from a row (since customers use `status` and installs use `Status`).
 */
function renderFilterChips(view, rows, getStatus) {
  var opts = STATUS_OPTIONS[view];
  var current = filterState[view].status;
  // Build counts: total per status value
  var counts = { all: rows.length };
  rows.forEach(function(r) {
    var s = getStatus(r);
    if (s) counts[s] = (counts[s] || 0) + 1;
  });
  var html = '<div class="filter-chips">';
  opts.forEach(function(o) {
    var active = (current === o.value) ? ' active' : '';
    var count = counts[o.value] || 0;
    html += '<span class="filter-chip' + active + '" onclick="setStatusFilter(\'' + view + '\', \'' + esc(o.value) + '\')">' +
      esc(o.label) + ' <span class="chip-count">' + count + '</span></span>';
  });
  html += '</div>';
  return html;
}

function setStatusFilter(view, status) {
  filterState[view].status = status;
  if (view === 'customers') return refreshCustomersList();
  if (view === 'installs') return refreshInstallsList();
}

/**
 * Render a sortable <th>. The view name maps to sortState; the key is the
 * field on each row used for comparison; type is text/date/number.
 */
function sortableTh(view, label, key, type) {
  var s = sortState[view];
  var isActive = s.key === key;
  var indicator = isActive ? (s.dir === 'asc' ? '&#9650;' : '&#9660;') : '&#9651;';
  var cls = 'sortable' + (isActive ? ' sort-active' : '');
  return '<th class="' + cls + '" onclick="setSort(\'' + view + '\', \'' + esc(key) + '\', \'' + (type || 'text') + '\')">' +
    esc(label) + ' <span class="sort-indicator">' + indicator + '</span></th>';
}

function setSort(view, key, type) {
  var s = sortState[view];
  if (s.key === key) {
    s.dir = s.dir === 'asc' ? 'desc' : 'asc';
  } else {
    s.key = key;
    s.dir = 'asc';
    s.type = type || 'text';
  }
  // Customers and installs support partial table refresh so the filter
  // chips, search input, and focus state are preserved.
  if (view === 'customers') return refreshCustomersList();
  if (view === 'installs') return refreshInstallsList();
  loadView(view);
}

/**
 * Sort an array of row objects by the configured sort state.
 */
function applySort(rows, view) {
  var s = sortState[view];
  if (!s || !s.key) return rows;
  var key = s.key;
  var type = s.type;
  var dir = s.dir === 'asc' ? 1 : -1;
  var sorted = rows.slice();
  sorted.sort(function(a, b) {
    var av = a[key];
    var bv = b[key];
    // Empty/null values always sort to the bottom
    var aEmpty = av === null || av === undefined || av === '';
    var bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (type === 'date') {
      var ad = new Date(av).getTime();
      var bd = new Date(bv).getTime();
      if (isNaN(ad) && isNaN(bd)) return 0;
      if (isNaN(ad)) return 1;
      if (isNaN(bd)) return -1;
      return (ad - bd) * dir;
    }
    if (type === 'number') {
      return (parseFloat(av) - parseFloat(bv)) * dir;
    }
    // text
    var as = String(av).toLowerCase();
    var bs = String(bv).toLowerCase();
    if (as < bs) return -1 * dir;
    if (as > bs) return 1 * dir;
    return 0;
  });
  return sorted;
}

// ── Helpers ────────────────────────────────────────────────

function esc(str) {
  if (str === null || str === undefined || str === '') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(status) {
  if (!status) return '<span class="badge">--</span>';
  var cls = String(status).toLowerCase().replace(/[\s_]/g, '-');
  return '<span class="badge badge-' + cls + '">' + esc(status) + '</span>';
}

function formatDate(val) {
  if (!val) return '--';
  try {
    var d = new Date(val);
    if (isNaN(d.getTime())) return esc(String(val));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {
    return esc(String(val));
  }
}

function formatMoney(val) {
  if (!val && val !== 0) return '0.00';
  return Number(val).toFixed(2);
}

function infoRow(label, value) {
  return '<div class="info-row" style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9;">' +
    '<span style="color:#6b7280;font-size:0.85rem;flex-shrink:0;">' + label + '</span>' +
    '<span style="font-weight:500;text-align:right;word-break:break-word;">' + (value || '--') + '</span></div>';
}

function formatDateInput(val) {
  if (!val) return '';
  try {
    var d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  } catch (e) { return ''; }
}

// ── Toast Notifications ────────────────────────────────────

function toast(type, message, duration) {
  var container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  var el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  el.textContent = message;
  container.appendChild(el);
  // Trigger CSS transition
  setTimeout(function() { el.classList.add('toast-show'); }, 10);
  // Auto-dismiss
  setTimeout(function() {
    el.classList.remove('toast-show');
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
  }, duration || 3500);
}

// ── Confirm Modal (replaces native confirm) ────────────────

/**
 * Show a confirmation modal. Replaces native confirm()/alert().
 * opts: { title, message, confirmText, cancelText, destructive, onConfirm }
 * onConfirm receives a `done(errMsg)` callback. Call done() to close on success,
 * done('error message') to keep the modal open and show an error.
 */
function confirmModal(opts) {
  var confirmText = opts.confirmText || 'Confirm';
  var cancelText = opts.cancelText || 'Cancel';
  var btnClass = opts.destructive ? 'btn-danger' : 'btn-primary';

  var html = '<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">';
  html += '<div class="modal" style="max-width:440px;">';
  html += '<div class="modal-header"><h3>' + esc(opts.title || 'Confirm') + '</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<div class="modal-body"><div id="modal-msg"></div>';
  html += '<p class="confirm-message">' + esc(opts.message || '') + '</p>';
  html += '</div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn btn-outline" id="confirm-cancel-btn">' + esc(cancelText) + '</button>';
  html += '<button class="btn ' + btnClass + '" id="confirm-ok-btn">' + esc(confirmText) + '</button>';
  html += '</div></div></div>';

  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('confirm-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('confirm-ok-btn').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Working...';
    if (typeof opts.onConfirm === 'function') {
      opts.onConfirm(function(errMsg) {
        if (errMsg) {
          showModalMessage('error', errMsg);
          btn.disabled = false;
          btn.textContent = confirmText;
        } else {
          closeModal();
        }
      });
    } else {
      closeModal();
    }
  });
}

/**
 * Show a single-button info/error message modal. Replaces native alert().
 */
function messageModal(type, title, message) {
  var html = '<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">';
  html += '<div class="modal" style="max-width:440px;">';
  html += '<div class="modal-header"><h3>' + esc(title) + '</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<div class="modal-body">';
  if (type === 'error') {
    html += '<div class="modal-message error">' + esc(message) + '</div>';
  } else if (type === 'success') {
    html += '<div class="modal-message success">' + esc(message) + '</div>';
  } else {
    html += '<p class="confirm-message">' + esc(message) + '</p>';
  }
  html += '</div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn btn-primary" onclick="closeModal()">OK</button>';
  html += '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
}

// ── Modal System ───────────────────────────────────────────

function showModal(title, fields, onSave) {
  var html = '<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">';
  html += '<div class="modal">';
  html += '<div class="modal-header"><h3>' + esc(title) + '</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
  html += '<div class="modal-body"><div id="modal-msg"></div>';

  fields.forEach(function(f) {
    html += '<div class="form-group">';
    html += '<label>' + esc(f.label) + '</label>';
    if (f.type === 'static') {
      html += '<p style="color:#6b7280;font-size:0.88rem;margin:0;">' + esc(f.value) + '</p>';
    } else if (f.type === 'select') {
      html += '<select id="modal-' + f.key + '">';
      // Skip the default placeholder if the field provides its own first
      // option (e.g., "(Unassigned)") or if a value is already selected.
      var hasOwnPlaceholder = f.options.length > 0 && (
        typeof f.options[0] === 'object'
          ? (f.options[0].value === '' || f.options[0].value === null || f.options[0].value === undefined)
          : f.options[0] === ''
      );
      if (!f.value && !hasOwnPlaceholder) html += '<option value="">-- Select --</option>';
      f.options.forEach(function(opt) {
        var v = (typeof opt === 'object') ? opt.value : opt;
        var l = (typeof opt === 'object') ? opt.label : opt;
        var selected = (String(f.value) === String(v)) ? ' selected' : '';
        html += '<option value="' + esc(v) + '"' + selected + '>' + esc(l) + '</option>';
      });
      html += '</select>';
    } else if (f.type === 'textarea') {
      html += '<textarea id="modal-' + f.key + '">' + esc(f.value || '') + '</textarea>';
    } else if (f.type === 'checkbox') {
      var checked = f.value ? ' checked' : '';
      html += '<label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">';
      html += '<input type="checkbox" id="modal-' + f.key + '"' + checked + ' style="width:auto;margin:0;">';
      html += '<span style="font-size:0.88rem;">' + esc(f.checkboxLabel || '') + '</span></label>';
      if (f.help) html += '<div style="font-size:0.78rem;color:#9ca3af;margin-top:4px;">' + esc(f.help) + '</div>';
    } else {
      html += '<input type="' + (f.type || 'text') + '" id="modal-' + f.key + '" value="' + esc(f.value || '') + '">';
    }
    html += '</div>';
  });

  html += '</div>';
  html += '<div class="modal-footer">';
  html += '<button class="btn btn-outline" onclick="closeModal()">Cancel</button>';
  html += '<button class="btn btn-primary" id="modal-save-btn">Save</button>';
  html += '</div></div></div>';

  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('modal-save-btn').addEventListener('click', function() {
    var values = {};
    fields.forEach(function(f) {
      if (f.type === 'static') return;
      var el = document.getElementById('modal-' + f.key);
      if (!el) return;
      if (f.type === 'checkbox') values[f.key] = el.checked ? 'true' : 'false';
      else values[f.key] = el.value;
    });
    // Disable button to prevent double-clicks
    this.disabled = true;
    this.textContent = 'Saving...';
    onSave(values);
  });
}

function closeModal() {
  var overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.remove();
}

function showModalMessage(type, text) {
  var el = document.getElementById('modal-msg');
  if (el) {
    el.innerHTML = '<div class="modal-message ' + type + '">' + esc(text) + '</div>';
  }
  // Re-enable save button
  var btn = document.getElementById('modal-save-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}

// ── Customer Notes ─────────────────────────────────────────

var notesAutoSaveTimer = null;

/**
 * Called on every keystroke in the notes textarea. Debounces and triggers
 * autoSaveNotes after 1.5s of inactivity.
 */
function onNotesInput() {
  if (notesAutoSaveTimer) clearTimeout(notesAutoSaveTimer);
  notesAutoSaveTimer = setTimeout(autoSaveNotes, 1500);
}

/**
 * Auto-save fires on blur and on debounced input. Only saves if the
 * textarea value differs from the last-known-saved value (data-original).
 * Silent on success (subtle toast) to avoid feeling noisy.
 */
function autoSaveNotes() {
  if (notesAutoSaveTimer) { clearTimeout(notesAutoSaveTimer); notesAutoSaveTimer = null; }
  var ta = document.getElementById('customer-notes');
  if (!ta) return;
  var current = ta.value;
  var baseline = ta.getAttribute('data-original') || '';
  if (current === baseline) return;
  var custId = ta.getAttribute('data-cust-id');
  if (!custId) return;
  apiCall('admin_update_customer_notes', { id: custId, notes: current }, function(err, data) {
    if (err || !data || !data.success) {
      toast('error', 'Failed to auto-save notes');
      return;
    }
    // Update baseline so we don't re-save the same value
    if (ta) ta.setAttribute('data-original', current);
    updateCachedNotes(custId, current);
    toast('success', 'Notes saved');
  });
}

/**
 * Manual save button -- bypasses the debounce and always pushes the
 * current value, with explicit button feedback.
 */
function saveCustomerNotes(custId) {
  if (notesAutoSaveTimer) { clearTimeout(notesAutoSaveTimer); notesAutoSaveTimer = null; }
  var ta = document.getElementById('customer-notes');
  if (!ta) return;
  var notes = ta.value;
  var btn = document.getElementById('save-notes-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  apiCall('admin_update_customer_notes', { id: custId, notes: notes }, function(err, data) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Notes'; }
    if (err || !data || !data.success) {
      toast('error', 'Failed to save notes');
      return;
    }
    if (ta) ta.setAttribute('data-original', notes);
    updateCachedNotes(custId, notes);
    toast('success', 'Notes saved');
  });
}

/**
 * Keep the cached customer record in sync so reopening the detail
 * page shows the latest notes without an extra round-trip.
 */
function updateCachedNotes(custId, notes) {
  var customersData = cachedData['admin_customers'] && cachedData['admin_customers'].data;
  if (!customersData || !customersData.customers) return;
  for (var i = 0; i < customersData.customers.length; i++) {
    if (customersData.customers[i].stripeCustomerId === custId) {
      customersData.customers[i].notes = notes;
      return;
    }
  }
}

// ── CSV Export ──────────────────────────────────────────────

function exportCustomers() { if (window._lastCustomers) exportToCSV(window._lastCustomers, 'customers.csv'); }

// ── Suspend / Unsuspend ────────────────────────────────────

function suspendCustomer(custId, name) {
  confirmModal({
    title: 'Suspend Service?',
    message: 'Suspend service for ' + name + '? This will pause their subscription and send them a notification email.',
    confirmText: 'Suspend',
    destructive: true,
    onConfirm: function(done) {
      apiCall('admin_suspend_customer', { id: custId }, function(err, data) {
        if (err || !data || !data.success) {
          done('Failed to suspend: ' + (data ? data.message || data.error : err.message));
          return;
        }
        done();
        toast('success', name + ' suspended');
        // Clear cache and reload customer detail
        delete cachedData['admin_customers'];
        delete cachedData['admin_dashboard'];
        viewCustomer(custId);
      });
    }
  });
}

function unsuspendCustomer(custId, name) {
  confirmModal({
    title: 'Restore Service?',
    message: 'Restore service for ' + name + '? This will resume their subscription and send them a notification.',
    confirmText: 'Restore',
    onConfirm: function(done) {
      apiCall('admin_unsuspend_customer', { id: custId }, function(err, data) {
        if (err || !data || !data.success) {
          done('Failed to restore: ' + (data ? data.message || data.error : err.message));
          return;
        }
        done();
        toast('success', name + ' restored');
        delete cachedData['admin_customers'];
        delete cachedData['admin_dashboard'];
        viewCustomer(custId);
      });
    }
  });
}

// ── Delete Customer ────────────────────────────────────────

function deleteCustomer(custId, name) {
  confirmModal({
    title: 'Delete ' + name + '?',
    message: 'This will cancel their Stripe subscription and remove them from the system. This cannot be undone.',
    confirmText: 'Delete Permanently',
    destructive: true,
    onConfirm: function(done) {
      apiCall('admin_delete_customer', { id: custId }, function(err, data) {
        if (err || !data || !data.success) {
          done('Failed to delete: ' + (data ? data.message || data.error : err.message));
          return;
        }
        done();
        toast('success', name + ' deleted');
        delete cachedData['admin_customers'];
        delete cachedData['admin_dashboard'];
        loadView('customers');
      });
    }
  });
}

// ── Manual Customer Creation ───────────────────────────────

function addCustomerManual() {
  showModal('Add New Customer', [
    { label: 'Full Name', key: 'full_name', type: 'text', value: '' },
    { label: 'Email', key: 'email', type: 'text', value: '' },
    { label: 'Phone', key: 'phone', type: 'text', value: '' },
    { label: 'Service Address', key: 'address', type: 'text', value: '' },
    { label: 'Plan', key: 'plan', type: 'select', value: '', options: PLAN_OPTIONS },
    { label: 'Notes', key: 'notes', type: 'textarea', value: '' }
  ], function(values) {
    if (!values.full_name || !values.email || !values.plan) {
      return showModalMessage('error', 'Name, email, and plan are required.');
    }
    apiCall('admin_create_customer', values, function(err, data) {
      if (err || !data || !data.success) {
        return showModalMessage('error', 'Failed: ' + (data ? data.message || data.error : err.message));
      }
      closeModal();
      delete cachedData['admin_customers'];
      delete cachedData['admin_dashboard'];
      delete cachedData['admin_installs'];
      delete cachedData['admin_leads'];
      loadView('customers');
    });
  });
}

// ── Lead Management ────────────────────────────────────────

function editLead(lead) {
  showModal('Edit Lead', [
    { label: 'Name', type: 'static', value: lead['Full Name'] },
    { label: 'Email', type: 'static', value: lead['Email'] },
    { label: 'Plan', type: 'static', value: lead['Plan'] },
    { label: 'Status', key: 'status', type: 'select', value: lead['Lead Status'], options: ['Checkout Sent', 'Contacted', 'No Response', 'Not Interested', 'Paid'] },
    { label: 'Notes', key: 'notes', type: 'textarea', value: lead['Notes'] }
  ], function(values) {
    values.row = lead._rowNum;
    apiCall('admin_update_lead', values, function(err, data) {
      if (err || !data || !data.success) { return showModalMessage('error', 'Failed to save.'); }
      closeModal();
      delete cachedData['admin_leads'];
      loadView('leads');
    });
  });
}

function convertLeadManual(rowNum, name) {
  showModal('Mark Paid (Manual) — ' + name, [
    { label: 'About', type: 'static', value: 'Use when the customer paid via cash, check, or another method outside Stripe Checkout. The lead becomes a customer and an install row is created.' },
    { label: 'Payment Method', key: 'payment_method', type: 'select', value: 'cash', options: ['cash', 'check', 'stripe terminal', 'other'] },
    { label: 'Initial Payment Amount', key: 'paid_amount', type: 'text', value: '' },
    {
      label: 'Recurring billing',
      key: 'setup_billing',
      type: 'checkbox',
      value: true,
      checkboxLabel: 'Set up Stripe subscription (send_invoice mode) — recommended',
      help: 'Stripe will generate a monthly open invoice that you mark paid when you receive cash/check. Customers without this fall off the recurring-billing pipeline.'
    }
  ], function(values) {
    apiCall('admin_convert_lead_manual', {
      row: rowNum,
      payment_method: values.payment_method || 'manual',
      paid_amount: values.paid_amount || '',
      setup_billing: values.setup_billing || 'true'
    }, function(err, data) {
      if (err || !data || !data.success) {
        return showModalMessage('error', 'Failed: ' + (data ? (data.message || data.error) : err.message));
      }
      closeModal();
      var msg = name + ' converted to customer';
      if (data.billingMethod === 'manual') msg += ' (Stripe subscription created)';
      toast('success', msg);
      delete cachedData['admin_leads'];
      delete cachedData['admin_customers'];
      delete cachedData['admin_dashboard'];
      delete cachedData['admin_installs'];
      loadView('leads');
    });
  });
}

function copyCheckoutLink(url) {
  navigator.clipboard.writeText(url).then(function() {
    toast('success', 'Checkout link copied to clipboard');
  }).catch(function() {
    // Fallback for older browsers
    prompt('Copy this checkout link:', url);
  });
}

function resendCheckout(rowNum) {
  confirmModal({
    title: 'Resend Checkout Link?',
    message: 'A new payment link will be generated and emailed to this lead.',
    confirmText: 'Resend',
    onConfirm: function(done) {
      apiCall('admin_resend_checkout', { row: rowNum }, function(err, data) {
        if (err || !data || !data.success) {
          done('Failed to resend: ' + (data ? data.message || data.error : err.message));
          return;
        }
        done();
        toast('success', 'Checkout link sent');
        delete cachedData['admin_leads'];
        loadView('leads');
      });
    }
  });
}

function exportToCSV(data, filename) {
  if (!data || data.length === 0) return;
  var headers = Object.keys(data[0]).filter(function(k) { return k !== '_rowNum'; });
  var csv = headers.join(',') + '\n';
  data.forEach(function(row) {
    csv += headers.map(function(h) {
      var val = String(row[h] || '').replace(/"/g, '""');
      return '"' + val + '"';
    }).join(',') + '\n';
  });
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || 'export.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

// ── Terminal Reader ────────────────────────────────────────

var readerStatusInterval = null;
var readerLastStatus = null;

function startReaderStatusPolling() {
  if (readerStatusInterval) return;
  pollReaderStatus();
  // Re-check every 60s so the pill reflects reality if the device sleeps.
  readerStatusInterval = setInterval(pollReaderStatus, 60000);
}

function pollReaderStatus() {
  apiCall('admin_reader_status', null, function(err, data) {
    var pill = document.getElementById('reader-status-pill');
    if (!pill) return;
    if (err || !data || data.configured === false) {
      // Don't show the pill at all if the reader isn't configured -- no point
      // surfacing a permanent red dot when the Script Property is just unset.
      pill.style.display = 'none';
      readerLastStatus = null;
      return;
    }
    readerLastStatus = data.status;
    pill.style.display = '';
    if (data.status === 'online') {
      pill.textContent = 'Reader: Online';
      pill.style.background = '#d1fae5';
      pill.style.color = '#065f46';
    } else {
      pill.textContent = 'Reader: Offline';
      pill.style.background = '#fee2e2';
      pill.style.color = '#991b1b';
    }
  });
}

/**
 * "Charge with Reader" from a customer row. Opens a small form, then hands
 * off to the shared push-and-wait flow.
 */
function chargeCustomerWithReader(custId, name) {
  if (readerLastStatus && readerLastStatus !== 'online') {
    return messageModal('error', 'Reader Offline',
      'The Terminal reader is currently offline. Power it on and wait for it to reconnect, then try again.');
  }
  showModal('Charge ' + name + ' with Reader', [
    { label: 'Amount (USD)', key: 'amount', type: 'number', value: '' },
    { label: 'Description', key: 'description', type: 'text', value: 'In-person payment' },
    { label: 'Note', type: 'static', value: 'The charge will appear on the S700. The customer taps/inserts their card to complete. The payment is linked to this customer in Stripe automatically.' }
  ], function(values) {
    var amount = parseFloat(values.amount);
    if (!amount || amount <= 0) return showModalMessage('error', 'Enter a valid amount greater than 0.');
    if (amount < 0.50) return showModalMessage('error', 'Minimum charge is $0.50.');
    var description = String(values.description || '').trim();
    if (!description) return showModalMessage('error', 'Description is required.');
    pushReaderCharge({
      amount: amount,
      description: description,
      customerId: custId,
      label: name,
      onSuccess: function() {
        // Bust caches so the customer's payment history reflects the new charge.
        delete cachedData['admin_customers'];
        delete cachedData['admin_dashboard'];
        if (paymentHistoryCache && paymentHistoryCache[custId]) delete paymentHistoryCache[custId];
        // If we're still on this customer's detail view, reload the payment
        // history section so the new charge shows up.
        if (viewingCustomerId === custId) {
          apiCall('admin_customers', null, function() { loadPaymentHistory(custId); });
        }
      }
    });
  });
}

/**
 * Quick Charge view -- ad-hoc in-person charge not tied to a WISP customer.
 */
function loadQuickCharge(container) {
  // The initial data prefetch re-renders the current view when cache chunks
  // arrive. That wipes any text the operator has typed. Quick Charge does
  // not depend on any prefetched data, so skip the re-render if the form
  // is already on screen.
  if (document.getElementById('qc-amount')) return;

  var statusPill = '';
  if (readerLastStatus === 'online') {
    statusPill = '<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#d1fae5;color:#065f46;font-size:0.8rem;font-weight:600;">Reader Online</span>';
  } else if (readerLastStatus === 'offline') {
    statusPill = '<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:0.8rem;font-weight:600;">Reader Offline</span>';
  } else {
    statusPill = '<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#f3f4f6;color:#6b7280;font-size:0.8rem;font-weight:600;">Checking reader...</span>';
  }

  var html = '';
  html += '<div class="panel"><div class="panel-header"><h2>Quick Charge</h2>' + statusPill + '</div>';
  html += '<div class="panel-body">';
  html += '<p style="color:#6b7280;font-size:0.88rem;margin-top:0;">Use this to take an in-person payment for anything that is <strong>not</strong> tied to a WISP subscriber (merchandise, ad-hoc fees, other NNA sales, etc). The payment will land in Stripe without being linked to a customer record.</p>';
  html += '<div class="form-group"><label>Amount (USD)</label>';
  html += '<input type="number" id="qc-amount" min="0.50" step="0.01" placeholder="25.00" style="width:100%;">';
  html += '</div>';
  html += '<div class="form-group"><label>Description</label>';
  html += '<input type="text" id="qc-description" placeholder="What is this charge for?" style="width:100%;">';
  html += '</div>';
  html += '<button class="btn btn-success" onclick="submitQuickCharge()" style="margin-top:8px;">Send to Reader</button>';
  html += '</div></div>';

  container.innerHTML = html;
  // Focus the amount field for fast keying.
  setTimeout(function() {
    var a = document.getElementById('qc-amount');
    if (a) a.focus();
  }, 50);
}

function submitQuickCharge() {
  var amountEl = document.getElementById('qc-amount');
  var descEl = document.getElementById('qc-description');
  if (!amountEl || !descEl) return;

  var amount = parseFloat(amountEl.value);
  var description = String(descEl.value || '').trim();

  if (!amount || amount <= 0) return messageModal('error', 'Invalid Amount', 'Enter an amount greater than 0.');
  if (amount < 0.50) return messageModal('error', 'Invalid Amount', 'Minimum charge is $0.50.');
  if (!description) return messageModal('error', 'Missing Description', 'Description is required so the charge is identifiable in Stripe.');
  if (readerLastStatus && readerLastStatus !== 'online') {
    return messageModal('error', 'Reader Offline', 'The Terminal reader is currently offline. Power it on and wait for it to reconnect, then try again.');
  }

  pushReaderCharge({
    amount: amount,
    description: description,
    customerId: null,
    label: 'Quick Charge',
    onSuccess: function() {
      // Clear the form for the next sale.
      if (amountEl) amountEl.value = '';
      if (descEl) descEl.value = '';
      if (amountEl) amountEl.focus();
    }
  });
}

/**
 * Shared push-and-wait modal. Pushes the charge to the reader, then polls
 * the PaymentIntent every 2 seconds until it reaches a terminal state
 * (succeeded, canceled, or the poll times out).
 *
 * opts: { amount (dollars), description, customerId (or null), label, onSuccess }
 */
var _readerPollHandle = null;
var _readerPollTimeout = null;

function pushReaderCharge(opts) {
  // Render the modal immediately in "sending" state so the operator gets
  // feedback while the first API call (create intent + push to reader) runs.
  renderReaderModal({
    state: 'sending',
    label: opts.label,
    amount: opts.amount,
    description: opts.description
  });

  apiCall('admin_reader_charge', {
    amount: String(opts.amount),
    description: opts.description,
    customer_id: opts.customerId || '',
    require_confirm: 'true'
  }, function(err, data) {
    if (err || !data || !data.success) {
      var msg = err ? err.message : (data && (data.message || data.error)) || 'Failed to send to reader.';
      renderReaderModal({
        state: 'error',
        label: opts.label,
        amount: opts.amount,
        message: msg
      });
      return;
    }

    var paymentIntentId = data.paymentIntentId;

    if (data.awaitingConfirm) {
      renderReaderModal({
        state: 'waiting_confirm',
        label: opts.label,
        amount: opts.amount,
        description: opts.description,
        onCancel: function() { cancelReaderCharge(paymentIntentId); }
      });
      pollReaderAction(paymentIntentId, opts);
    } else {
      // Fallback: backend couldn't run collect_inputs, payment already
      // processing. Jump straight to card-waiting state.
      renderReaderModal({
        state: 'waiting',
        label: opts.label,
        amount: opts.amount,
        description: opts.description,
        paymentIntentId: paymentIntentId,
        onCancel: function() { cancelReaderCharge(paymentIntentId); }
      });
      pollPaymentIntent(paymentIntentId, opts);
    }
  });
}

/**
 * Phase 1 poll: customer is viewing Confirm / Cancel on the reader. Watch
 * the reader's action.collect_inputs.selection value. When they tap
 * Confirm we kick off process_payment_intent and switch to phase 2.
 */
function pollReaderAction(paymentIntentId, opts) {
  var pollCount = 0;
  var maxPolls = 180; // 3 min at 1s interval -- faster polling to shrink the
                       // gap between Confirm tap and the tap-to-pay screen.
  function poll() {
    pollCount++;
    apiCall('admin_reader_action_status', null, function(err, data) {
      if (!document.getElementById('reader-modal-overlay')) return;
      if (err || !data) {
        if (pollCount < maxPolls) _readerPollTimeout = setTimeout(poll, 1000);
        return;
      }

      // Customer tapped a button
      if (data.selection === 'confirm') {
        renderReaderModal({
          state: 'waiting',
          label: opts.label,
          amount: opts.amount,
          description: opts.description,
          paymentIntentId: paymentIntentId,
          onCancel: function() { cancelReaderCharge(paymentIntentId); }
        });
        apiCall('admin_reader_start_payment', { payment_intent_id: paymentIntentId }, function(e2, d2) {
          if (e2 || !d2 || !d2.success) {
            renderReaderModal({
              state: 'error',
              label: opts.label,
              amount: opts.amount,
              message: (d2 && (d2.message || d2.error)) || (e2 && e2.message) || 'Could not start card collection.'
            });
            return;
          }
          pollPaymentIntent(paymentIntentId, opts);
        });
        return;
      }
      if (data.selection === 'cancel') {
        cancelReaderCharge(paymentIntentId);
        renderReaderModal({
          state: 'error',
          label: opts.label,
          amount: opts.amount,
          message: 'Customer canceled the charge.'
        });
        return;
      }

      // Still waiting. Give up after 3 min so we don't leak a stuck action.
      if (pollCount >= maxPolls) {
        cancelReaderCharge(paymentIntentId);
        renderReaderModal({
          state: 'error',
          label: opts.label,
          amount: opts.amount,
          message: 'Customer did not respond in time.'
        });
        return;
      }
      _readerPollTimeout = setTimeout(poll, 1000);
    });
  }
  _readerPollTimeout = setTimeout(poll, 1000);
}

/**
 * Phase 2 poll: card has been requested on the reader, watch the
 * PaymentIntent for terminal state.
 */
function pollPaymentIntent(paymentIntentId, opts) {
  var pollCount = 0;
  var maxPolls = 90; // 90 * 2s = 3 min
  function poll() {
    pollCount++;
    apiCall('admin_reader_payment_status', { payment_intent_id: paymentIntentId }, function(e2, d2) {
      if (!document.getElementById('reader-modal-overlay')) return;
      if (e2 || !d2) {
        if (pollCount < maxPolls) _readerPollTimeout = setTimeout(poll, 2000);
        return;
      }
      if (d2.status === 'succeeded') {
        renderReaderModal({
          state: 'success',
          label: opts.label,
          amount: opts.amount,
          description: opts.description
        });
        toast('success', 'Payment of $' + opts.amount.toFixed(2) + ' captured');
        if (typeof opts.onSuccess === 'function') opts.onSuccess();
        return;
      }
      if (d2.status === 'canceled') {
        renderReaderModal({
          state: 'error',
          label: opts.label,
          amount: opts.amount,
          message: 'Payment was canceled.'
        });
        return;
      }
      if (d2.status === 'requires_payment_method' && d2.lastError) {
        renderReaderModal({
          state: 'error',
          label: opts.label,
          amount: opts.amount,
          message: d2.lastError
        });
        return;
      }
      if (pollCount >= maxPolls) {
        renderReaderModal({
          state: 'error',
          label: opts.label,
          amount: opts.amount,
          message: 'Timed out waiting for payment. Check the reader and the Stripe dashboard.'
        });
        return;
      }
      _readerPollTimeout = setTimeout(poll, 2000);
    });
  }
  _readerPollTimeout = setTimeout(poll, 2000);
}

function cancelReaderCharge(paymentIntentId) {
  // Best-effort cancel on the reader. Don't wait for the poll -- update the
  // modal immediately so the operator gets snappy feedback.
  if (_readerPollTimeout) { clearTimeout(_readerPollTimeout); _readerPollTimeout = null; }
  renderReaderModal({ state: 'canceling' });
  apiCall('admin_reader_cancel', null, function(err, data) {
    closeReaderModal();
    if (err) {
      toast('error', 'Cancel sent but got an error: ' + err.message);
    } else {
      toast('success', 'Reader charge canceled');
    }
  });
}

function renderReaderModal(opts) {
  // Clean up any existing modal so we can re-render for state changes.
  var existing = document.getElementById('reader-modal-overlay');
  if (existing) existing.remove();

  var state = opts.state;
  var amountFmt = opts.amount != null ? '$' + Number(opts.amount).toFixed(2) : '';

  var body = '';
  var footer = '';

  if (state === 'sending') {
    body = '<div style="text-align:center;padding:16px 0;">' +
      '<div class="loading-spinner" style="margin:0 auto 14px;"></div>' +
      '<p style="font-weight:600;margin:0;">Sending ' + esc(amountFmt) + ' to reader...</p>' +
      '</div>';
    footer = '';
  } else if (state === 'waiting_confirm') {
    body = '<div style="text-align:center;padding:16px 0;">' +
      '<div class="loading-spinner" style="margin:0 auto 14px;"></div>' +
      '<p style="font-weight:600;font-size:1.15rem;margin:0 0 6px;">' + esc(amountFmt) + '</p>' +
      '<p style="margin:0 0 6px;color:#6b7280;font-size:0.88rem;">' + esc(opts.description || '') + '</p>' +
      '<p style="margin:14px 0 0;font-size:0.95rem;">Waiting for customer to confirm on reader...</p>' +
      '<p style="margin:4px 0 0;font-size:0.78rem;color:#9ca3af;">Customer taps Confirm or Cancel on the S700.</p>' +
      '</div>';
    footer = '<button class="btn btn-outline" id="reader-modal-cancel">Abort</button>';
  } else if (state === 'waiting') {
    body = '<div style="text-align:center;padding:16px 0;">' +
      '<div class="loading-spinner" style="margin:0 auto 14px;"></div>' +
      '<p style="font-weight:600;font-size:1.15rem;margin:0 0 6px;">' + esc(amountFmt) + '</p>' +
      '<p style="margin:0 0 6px;color:#6b7280;font-size:0.88rem;">' + esc(opts.description || '') + '</p>' +
      '<p style="margin:14px 0 0;font-size:0.95rem;">Waiting for card on reader...</p>' +
      '<p style="margin:4px 0 0;font-size:0.78rem;color:#9ca3af;">Customer taps, inserts, or swipes on the S700.</p>' +
      '</div>';
    footer = '<button class="btn btn-outline" id="reader-modal-cancel">Cancel Charge</button>';
  } else if (state === 'canceling') {
    body = '<div style="text-align:center;padding:16px 0;">' +
      '<div class="loading-spinner" style="margin:0 auto 14px;"></div>' +
      '<p style="margin:0;">Canceling on reader...</p></div>';
    footer = '';
  } else if (state === 'success') {
    body = '<div style="text-align:center;padding:16px 0;">' +
      '<div style="font-size:48px;line-height:1;color:#059669;margin-bottom:10px;">&#10004;</div>' +
      '<p style="font-weight:600;font-size:1.15rem;margin:0 0 6px;">Paid ' + esc(amountFmt) + '</p>' +
      '<p style="margin:0;color:#6b7280;font-size:0.88rem;">' + esc(opts.description || '') + '</p>' +
      '</div>';
    footer = '<button class="btn btn-primary" id="reader-modal-done">Done</button>';
  } else if (state === 'error') {
    body = '<div style="padding:10px 0;">' +
      '<div class="modal-message error">' + esc(opts.message || 'Something went wrong.') + '</div>' +
      '</div>';
    footer = '<button class="btn btn-outline" id="reader-modal-done">Close</button>';
  }

  var title = state === 'success' ? 'Payment Complete'
    : state === 'error' ? 'Charge Error'
    : state === 'canceling' ? 'Canceling'
    : 'Charge ' + (opts.label || '');

  var html = '<div class="modal-overlay" id="reader-modal-overlay">' +
    '<div class="modal" style="max-width:440px;">' +
    '<div class="modal-header"><h3>' + esc(title) + '</h3>' +
    (state === 'waiting' || state === 'sending' ? '' : '<button class="modal-close" onclick="closeReaderModal()">&times;</button>') +
    '</div>' +
    '<div class="modal-body">' + body + '</div>' +
    (footer ? '<div class="modal-footer">' + footer + '</div>' : '') +
    '</div></div>';

  document.body.insertAdjacentHTML('beforeend', html);

  if (state === 'waiting' || state === 'waiting_confirm') {
    var cancelBtn = document.getElementById('reader-modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function() {
      if (typeof opts.onCancel === 'function') opts.onCancel();
    });
  }
  var doneBtn = document.getElementById('reader-modal-done');
  if (doneBtn) doneBtn.addEventListener('click', closeReaderModal);
}

function closeReaderModal() {
  if (_readerPollTimeout) { clearTimeout(_readerPollTimeout); _readerPollTimeout = null; }
  var overlay = document.getElementById('reader-modal-overlay');
  if (overlay) overlay.remove();
}
