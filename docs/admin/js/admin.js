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
    loadView('dashboard');
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

// ── API Calls ──────────────────────────────────────────────

function apiCall(action, params, callback) {
  if (!adminToken) { logout(); return; }

  var url = APPS_SCRIPT_URL + '?action=' + action + '&token=' + encodeURIComponent(adminToken);
  if (params) {
    for (var key in params) {
      if (params.hasOwnProperty(key)) {
        url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      }
    }
  }

  fetch(url)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.error === 'unauthorized') {
        logout();
        showAuthError('Session expired. Please sign in again.');
        return;
      }
      callback(null, data);
    })
    .catch(function(err) {
      callback(err, null);
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
  currentView = view;
  var content = document.getElementById('content-area');
  var title = document.getElementById('page-title');
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading...</p></div>';

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

// ── Dashboard View ─────────────────────────────────────────

function loadDashboard(container) {
  apiCall('admin_dashboard', null, function(err, data) {
    if (err || !data || !data.summary) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load dashboard data.</p></div>';
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
        html += '<tr><td>' + esc(c.name) + '<br><small style="color:#6b7280;">' + esc(c.email) + '</small></td>';
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
        html += '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.plan) + '</td><td>' + formatDate(c.date) + '</td></tr>';
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
  apiCall('admin_customers', params, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load customers.</p></div>';
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
    html += '<div class="panel"><div class="panel-header"><h2>Customers (' + data.total + ')</h2></div>';
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
  var content = document.getElementById('content-area');
  document.getElementById('page-title').textContent = 'Customer Detail';
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading...</p></div>';

  apiCall('admin_customer_detail', { id: custId }, function(err, data) {
    if (err || !data || data.error) {
      content.innerHTML = '<div class="empty-state"><p>Customer not found.</p></div>';
      return;
    }
    var c = data.customer;
    var html = '';

    html += '<p style="margin-bottom:16px;"><button class="btn btn-sm" onclick="loadView(\'customers\')">&larr; Back to Customers</button></p>';

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

    // Notes
    html += '<div class="panel"><div class="panel-header"><h2>Notes</h2></div>';
    html += '<div class="panel-body"><p style="color:#6b7280;">' + (esc(c['Notes']) || 'No notes.') + '</p></div></div>';

    content.innerHTML = html;
  });
}

// ── Leads View ─────────────────────────────────────────────

function loadLeads(container) {
  apiCall('admin_leads', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load leads.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>All Leads</h2></div>';
    if (data.leads && data.leads.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Date</th><th>Name</th><th>Email</th><th>Plan</th><th>Status</th></tr>';
      data.leads.forEach(function(l) {
        html += '<tr>';
        html += '<td>' + formatDate(l['Timestamp']) + '</td>';
        html += '<td>' + esc(l['Full Name']) + '</td>';
        html += '<td>' + esc(l['Email']) + '</td>';
        html += '<td>' + esc(l['Plan']) + '</td>';
        html += '<td>' + badge(l['Lead Status']) + '</td>';
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
  apiCall('admin_installs', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load installs.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>Installations</h2></div>';
    if (data.installs && data.installs.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Customer</th><th>Address</th><th>Plan</th><th>Scheduled</th><th>Technician</th><th>Status</th></tr>';
      data.installs.forEach(function(inst) {
        html += '<tr>';
        html += '<td><strong>' + esc(inst['Customer Name']) + '</strong><br><small style="color:#6b7280;">' + esc(inst['Email']) + '</small></td>';
        html += '<td>' + esc(inst['Service Address']) + '</td>';
        html += '<td>' + esc(inst['Plan']) + '</td>';
        html += '<td>' + formatDate(inst['Scheduled Date']) + '</td>';
        html += '<td>' + esc(inst['Technician']) + '</td>';
        html += '<td>' + badge(inst['Status']) + '</td>';
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

// ── Equipment View ─────────────────────────────────────────

function loadEquipment(container) {
  apiCall('admin_equipment', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load equipment.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>Equipment Inventory</h2></div>';
    if (data.equipment && data.equipment.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Type</th><th>Make/Model</th><th>Serial</th><th>MAC</th><th>IP</th><th>Assigned To</th><th>Status</th></tr>';
      data.equipment.forEach(function(eq) {
        html += '<tr>';
        html += '<td>' + esc(eq['Device Type']) + '</td>';
        html += '<td>' + esc(eq['Make/Model']) + '</td>';
        html += '<td>' + esc(eq['Serial Number']) + '</td>';
        html += '<td><code>' + esc(eq['MAC Address']) + '</code></td>';
        html += '<td><code>' + esc(eq['IP Address']) + '</code></td>';
        html += '<td>' + esc(eq['Assigned To']) + '</td>';
        html += '<td>' + badge(eq['Status']) + '</td>';
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

// ── Support View ───────────────────────────────────────────

function loadSupport(container) {
  apiCall('admin_support', null, function(err, data) {
    if (err || !data) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load tickets.</p></div>';
      return;
    }
    var html = '<div class="panel"><div class="panel-header"><h2>Support Tickets</h2></div>';
    if (data.tickets && data.tickets.length > 0) {
      html += '<div class="panel-body no-pad"><table class="data-table">';
      html += '<tr><th>Ticket</th><th>Customer</th><th>Date</th><th>Category</th><th>Description</th><th>Status</th></tr>';
      data.tickets.forEach(function(t) {
        html += '<tr>';
        html += '<td><strong>' + esc(t['Ticket #']) + '</strong></td>';
        html += '<td>' + esc(t['Customer Name']) + '<br><small style="color:#6b7280;">' + esc(t['Email']) + '</small></td>';
        html += '<td>' + formatDate(t['Date Opened']) + '</td>';
        html += '<td>' + esc(t['Category']) + '</td>';
        html += '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t['Description']) + '</td>';
        html += '<td>' + badge(t['Status']) + '</td>';
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
