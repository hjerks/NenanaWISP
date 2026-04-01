/**
 * admin.js -- Admin portal logic for NenanaWISP
 *
 * Handles: authentication, view routing, data fetching, and rendering.
 *
 * CONFIGURATION: Set APPS_SCRIPT_URL to your deployed Apps Script web app URL.
 */

// ── Configuration ──────────────────────────────────────────
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwZV3Gljv5z5-RrOpM9eo3jDfQ7L_5E9fJYiDmISXli__tX_NWeW4i3zoGRxC08Ykr_4g/exec';

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
  // Check for token in URL hash (from OAuth redirect)
  var hash = window.location.hash;
  if (hash.indexOf('#token=') === 0) {
    adminToken = hash.substring(7);
    sessionStorage.setItem('adminToken', adminToken);
    window.location.hash = '';
  }

  // Check sessionStorage for existing token
  if (!adminToken) {
    adminToken = sessionStorage.getItem('adminToken');
  }

  if (adminToken) {
    showApp();
    prefetchAllData();
  }

  // Set up navigation
  setupNav();
});

// ── Authentication ─────────────────────────────────────────

function startAuth() {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
    showAuthError('Admin portal is not yet configured. Set the Apps Script URL in admin.js');
    return;
  }
  var redirect = encodeURIComponent(window.location.href.split('#')[0]);
  window.location.href = APPS_SCRIPT_URL + '?action=auth&redirect=' + redirect;
}

function logout() {
  adminToken = null;
  adminEmail = null;
  cachedData = {};
  sessionStorage.removeItem('adminToken');
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('admin-app').style.display = 'none';
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
  var params = search ? { search: search } : {};
  getCachedOrFetch('admin_customers', params, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load customers.</p><p style="margin-top:12px;"><button class="btn btn-primary" onclick="loadView(\'customers\')">Retry</button></p></div>';
      return;
    }
    var html = '';

    // Search bar
    html += '<div class="panel"><div class="panel-body">';
    html += '<div class="search-bar">';
    html += '<input type="text" id="customer-search" placeholder="Search by name, email, or address..." value="' + esc(search || '') + '" onkeydown="if(event.key===\'Enter\')searchCustomers()">';
    html += '<button onclick="searchCustomers()">Search</button>';
    html += '</div></div></div>';

    // Table
    html += '<div class="panel"><div class="panel-header"><h2>Customers (' + data.total + ')</h2><div class="btn-group"><button class="btn btn-sm btn-success" onclick="addCustomerManual()">+ New Customer</button><button class="btn btn-sm btn-outline" onclick="exportCustomers()">Export CSV</button></div></div>';
    // Store for export
    window._lastCustomers = data.customers;
    if (data.customers && data.customers.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Name</th><th>Email</th><th>Plan</th><th>Status</th><th>Last Payment</th><th></th></tr>';
      data.customers.forEach(function(c) {
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
    } else {
      html += '<div class="panel-body"><div class="empty-state"><p>No customers found.</p></div></div>';
    }
    html += '</div>';

    container.innerHTML = html;
  });
}

function searchCustomers() {
  var search = document.getElementById('customer-search').value.trim();
  loadCustomers(document.getElementById('content-area'), search);
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
    'Stripe Subscription ID': '',
    'Monthly Price': '',
    'Portal Link': '',
    'Last Event': '',
    'Notes': ''
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

  html += '<div class="action-bar">';
  html += '<button class="btn btn-sm btn-outline" onclick="loadView(\'customers\')">&larr; Back to Customers</button>';
  html += '<button class="btn btn-sm btn-primary" onclick="createTicket(\'' + esc(c['Full Name']).replace(/'/g, "\\'") + '\',\'' + esc(c['Email']).replace(/'/g, "\\'") + '\')">Create Ticket</button>';
  html += '<a class="btn btn-sm btn-outline" href="https://dashboard.stripe.com/customers/' + esc(c['Stripe Customer ID']) + '" target="_blank">Open in Stripe</a>';
  var subStatus = c['Subscription Status'];
  if (subStatus === 'active' || subStatus === 'past_due') {
    html += '<button class="btn btn-sm btn-danger" onclick="suspendCustomer(\'' + esc(c['Stripe Customer ID']) + '\', \'' + esc(c['Full Name']).replace(/'/g, "\\'") + '\')">Suspend Service</button>';
  } else if (subStatus === 'suspended') {
    html += '<button class="btn btn-sm btn-success" onclick="unsuspendCustomer(\'' + esc(c['Stripe Customer ID']) + '\', \'' + esc(c['Full Name']).replace(/'/g, "\\'") + '\')">Restore Service</button>';
  }
  html += '<button class="btn btn-sm btn-danger" onclick="deleteCustomer(\'' + esc(c['Stripe Customer ID']) + '\', \'' + esc(c['Full Name']).replace(/'/g, "\\'") + '\')">Delete</button>';
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
  html += infoRow('Status', badge(c['Subscription Status']));
  html += infoRow('Subscription ID', c['Stripe Subscription ID']);
  html += infoRow('Monthly Price', c['Monthly Price'] ? '$' + c['Monthly Price'] : '--');
  html += infoRow('Signup Date', formatDate(c['Signup Date']));
  html += infoRow('Last Payment', formatDate(c['Last Payment Date']));
  html += infoRow('Last Event', c['Last Event']);
  html += '</div></div>';
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
  html += '<textarea id="customer-notes" style="width:100%;min-height:80px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-family:inherit;font-size:0.88rem;resize:vertical;">' + esc(c['Notes'] || '') + '</textarea>';
  html += '<button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="saveCustomerNotes(\'' + esc(custId) + '\')">Save Notes</button>';
  html += '<span id="notes-status" style="margin-left:8px;font-size:0.82rem;color:#6b7280;"></span>';
  html += '</div></div>';

  content.innerHTML = html;
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
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Date</th><th>Name</th><th>Email</th><th>Plan</th><th>Status</th><th></th></tr>';
      visibleLeads.forEach(function(l) {
        html += '<tr>';
        html += '<td>' + formatDate(l['Timestamp']) + '</td>';
        html += '<td>' + esc(l['Full Name']) + '</td>';
        html += '<td>' + esc(l['Email']) + '</td>';
        html += '<td>' + esc(l['Plan']) + '</td>';
        html += '<td>' + badge(l['Lead Status']) + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-sm btn-outline" onclick=\'editLead(' + JSON.stringify(l) + ')\'>Edit</button>';
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
    var html = '<div class="panel"><div class="panel-header"><h2>Installations</h2></div>';
    if (data.installs && data.installs.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Customer</th><th>Address</th><th>Plan</th><th>Scheduled</th><th>Technician</th><th>Status</th><th></th></tr>';
      data.installs.forEach(function(inst) {
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
    } else {
      html += '<div class="panel-body"><div class="empty-state"><div class="icon">&#128295;</div><p>No installations.</p></div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  });
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
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Type</th><th>Make/Model</th><th>Serial</th><th>MAC</th><th>IP</th><th>Assigned To</th><th>Status</th><th></th></tr>';
      data.equipment.forEach(function(eq) {
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
    { label: 'Assigned To (email)', key: 'assigned_to', type: 'text', value: eq ? eq['Assigned To'] : '' },
    { label: 'Location', key: 'location', type: 'text', value: eq ? eq['Location'] : '' },
    { label: 'Status', key: 'status', type: 'select', value: eq ? eq['Status'] : 'Available', options: ['Available', 'Deployed', 'RMA', 'Retired'] },
    { label: 'Notes', key: 'notes', type: 'textarea', value: eq ? eq['Notes'] : '' }
  ];
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
  return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;">' +
    '<span style="color:#6b7280;font-size:0.85rem;">' + label + '</span>' +
    '<span style="font-weight:500;">' + (value || '--') + '</span></div>';
}

function formatDateInput(val) {
  if (!val) return '';
  try {
    var d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  } catch (e) { return ''; }
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
      if (!f.value) html += '<option value="">-- Select --</option>';
      f.options.forEach(function(opt) {
        html += '<option value="' + esc(opt) + '"' + (f.value === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
      });
      html += '</select>';
    } else if (f.type === 'textarea') {
      html += '<textarea id="modal-' + f.key + '">' + esc(f.value || '') + '</textarea>';
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
      if (el) values[f.key] = el.value;
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

function saveCustomerNotes(custId) {
  var notes = document.getElementById('customer-notes').value;
  var status = document.getElementById('notes-status');
  status.textContent = 'Saving...';
  apiCall('admin_update_customer_notes', { id: custId, notes: notes }, function(err, data) {
    if (err || !data || !data.success) {
      status.textContent = 'Failed to save.';
      status.style.color = '#c0392b';
    } else {
      status.textContent = 'Saved!';
      status.style.color = '#27ae60';
      setTimeout(function() { status.textContent = ''; }, 3000);
    }
  });
}

// ── CSV Export ──────────────────────────────────────────────

function exportCustomers() { if (window._lastCustomers) exportToCSV(window._lastCustomers, 'customers.csv'); }

// ── Suspend / Unsuspend ────────────────────────────────────

function suspendCustomer(custId, name) {
  if (!confirm('Suspend service for ' + name + '? This will pause their subscription and send them a notification email.')) return;
  apiCall('admin_suspend_customer', { id: custId }, function(err, data) {
    if (err || !data || !data.success) {
      alert('Failed to suspend: ' + (data ? data.message || data.error : err.message));
      return;
    }
    // Clear cache and reload customer detail
    delete cachedData['admin_customers'];
    delete cachedData['admin_dashboard'];
    viewCustomer(custId);
  });
}

function unsuspendCustomer(custId, name) {
  if (!confirm('Restore service for ' + name + '? This will resume their subscription and send them a notification.')) return;
  apiCall('admin_unsuspend_customer', { id: custId }, function(err, data) {
    if (err || !data || !data.success) {
      alert('Failed to restore: ' + (data ? data.message || data.error : err.message));
      return;
    }
    delete cachedData['admin_customers'];
    delete cachedData['admin_dashboard'];
    viewCustomer(custId);
  });
}

// ── Delete Customer ────────────────────────────────────────

function deleteCustomer(custId, name) {
  if (!confirm('Delete ' + name + '? This will cancel their Stripe subscription and remove them from the system. This cannot be undone.')) return;
  if (!confirm('Are you sure? This is permanent.')) return;
  apiCall('admin_delete_customer', { id: custId }, function(err, data) {
    if (err || !data || !data.success) {
      alert('Failed to delete: ' + (data ? data.message || data.error : err.message));
      return;
    }
    delete cachedData['admin_customers'];
    delete cachedData['admin_dashboard'];
    loadView('customers');
  });
}

// ── Manual Customer Creation ───────────────────────────────

function addCustomerManual() {
  showModal('Add New Customer', [
    { label: 'Full Name', key: 'full_name', type: 'text', value: '' },
    { label: 'Email', key: 'email', type: 'text', value: '' },
    { label: 'Phone', key: 'phone', type: 'text', value: '' },
    { label: 'Service Address', key: 'address', type: 'text', value: '' },
    { label: 'Plan', key: 'plan', type: 'select', value: '', options: ['Residential 50/10 Mbps', 'Residential 100/20 Mbps', 'Business 100/100 Mbps'] },
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

function copyCheckoutLink(url) {
  navigator.clipboard.writeText(url).then(function() {
    alert('Checkout link copied! Open it on any device for in-person payment.');
  }).catch(function() {
    // Fallback for older browsers
    prompt('Copy this checkout link:', url);
  });
}

function resendCheckout(rowNum) {
  if (!confirm('Resend the checkout link email to this lead? A new payment link will be generated.')) return;
  apiCall('admin_resend_checkout', { row: rowNum }, function(err, data) {
    if (err || !data || !data.success) {
      alert('Failed to resend: ' + (data ? data.message || data.error : err.message));
      return;
    }
    alert('Checkout link sent successfully.');
    delete cachedData['admin_leads'];
    loadView('leads');
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
