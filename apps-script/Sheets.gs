/**
 * Sheets.gs -- Google Sheet read/write helpers and row finders
 * NenanaWISP Billing Platform
 */

// ── Tab Names ──────────────────────────────────────────────
var TAB_LEADS      = 'Leads';
var TAB_CUSTOMERS  = 'Customers';
var TAB_INSTALLS   = 'Installs';
var TAB_EQUIPMENT  = 'Equipment';
var TAB_SUPPORT    = 'Support';
var TAB_WEBHOOK_LOG = 'Webhook_Log';
var TAB_BROADCAST_LOG = 'Broadcast_Log';
var TAB_DASHBOARD  = 'Dashboard';

// ── Column Indexes (1-based) for Leads tab ─────────────────
var L = {
  TIMESTAMP:    1,
  FULL_NAME:    2,
  EMAIL:        3,
  PHONE:        4,
  ADDRESS:      5,
  CITY:         6,
  STATE:        7,
  ZIP:          8,
  PLAN:         9,
  CONTACT_PREF: 10,
  CONTACT_METHOD: 11,
  INSTALL_PREF: 12,
  NOTES:        13,
  TOS_AGREED:   14,
  ROW_KEY:      15,
  STRIPE_CUST_ID: 16,
  CHECKOUT_LINK: 17,
  LEAD_STATUS:  18,
  CREATED_DATE: 19,
  LATITUDE:     20,
  LONGITUDE:    21,
  REQUESTED_INSTALL_DATE: 22  // 'YYYY-MM-DD' or 'ASAP'
};

// ── Column Indexes (1-based) for Customers tab ─────────────
var C_ = {
  STRIPE_CUST_ID: 1,
  FULL_NAME:      2,
  EMAIL:          3,
  PHONE:          4,
  ADDRESS:        5,
  PLAN:           6,
  STRIPE_SUB_ID:  7,
  SUB_STATUS:     8,
  MONTHLY_PRICE:  9,
  PORTAL_LINK:    10,
  SIGNUP_DATE:    11,
  LAST_PAYMENT:   12,
  LAST_EVENT:     13,
  ROW_KEY:        14,
  NOTES:          15,
  BILLING_METHOD: 16   // 'auto' (Stripe charges card) or 'manual' (Stripe send_invoice)
};

// ── Column Indexes (1-based) for Installs tab ──────────────
var I_ = {
  CUSTOMER_NAME:    1,
  EMAIL:            2,
  ADDRESS:          3,
  PLAN:             4,
  REQUESTED_PREF:   5,
  SCHEDULED_DATE:   6,
  TECHNICIAN:       7,
  EQUIPMENT:        8,
  STATUS:           9,
  COMPLETION_DATE:  10,
  NOTES:            11,
  LATITUDE:         12,
  LONGITUDE:        13
};

// ── Column Indexes (1-based) for Equipment tab ─────────────
var EQ_ = {
  DEVICE_TYPE:  1,
  MAKE_MODEL:   2,
  SERIAL:       3,
  MAC:          4,
  IP:           5,
  VLAN:         6,
  ASSIGNED_TO:  7,
  INSTALL_DATE: 8,
  LOCATION:     9,
  STATUS:       10,
  NOTES:        11
};

// ── Column Indexes (1-based) for Support tab ───────────────
var S_ = {
  TICKET_NUMBER:  1,
  CUSTOMER_NAME:  2,
  EMAIL:          3,
  DATE_OPENED:    4,
  CATEGORY:       5,
  DESCRIPTION:    6,
  STATUS:         7,
  RESOLUTION:     8,
  RESOLVED_DATE:  9,
  NOTES:          10
};

// ── Sheet Headers ──────────────────────────────────────────

var LEADS_HEADERS = [
  'Timestamp', 'Full Name', 'Email', 'Phone', 'Service Address',
  'City', 'State', 'ZIP', 'Plan', 'Contact Preference',
  'Contact Method', 'Install Preference', 'Notes', 'TOS Agreed',
  'Row Key', 'Stripe Customer ID', 'Checkout Link', 'Lead Status', 'Created Date',
  'Latitude', 'Longitude', 'Requested Install Date'
];

var CUSTOMERS_HEADERS = [
  'Stripe Customer ID', 'Full Name', 'Email', 'Phone', 'Service Address',
  'Plan', 'Stripe Subscription ID', 'Subscription Status', 'Monthly Price',
  'Portal Link', 'Signup Date', 'Last Payment Date', 'Last Event',
  'Row Key', 'Notes', 'Billing Method',
  'Latitude', 'Longitude'
];

var INSTALLS_HEADERS = [
  'Customer Name', 'Email', 'Service Address', 'Plan',
  'Requested Preference', 'Scheduled Date', 'Technician',
  'Equipment Assigned', 'Status', 'Completion Date', 'Notes',
  'Latitude', 'Longitude'
];

var EQUIPMENT_HEADERS = [
  'Device Type', 'Make/Model', 'Serial Number', 'MAC Address',
  'IP Address', 'VLAN', 'Assigned To', 'Install Date',
  'Location', 'Status', 'Notes'
];

var SUPPORT_HEADERS = [
  'Ticket #', 'Customer Name', 'Email', 'Date Opened',
  'Category', 'Description', 'Status', 'Resolution',
  'Resolved Date', 'Notes'
];

var WEBHOOK_LOG_HEADERS = [
  'Timestamp', 'Event Type', 'Stripe Customer ID', 'Email',
  'Subscription ID', 'Row Key', 'Status', 'Payload Preview'
];

var BROADCAST_LOG_HEADERS = [
  'Timestamp', 'Sender Email', 'Subject', 'Body',
  'Recipient Count', 'Sent Count', 'Failed Count', 'Recipients', 'Failed Recipients'
];

// ── Sheet Access ───────────────────────────────────────────

/**
 * Get a sheet by name, creating it if it doesn't exist.
 */
function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

/**
 * Ensure a sheet has the correct headers in row 1.
 *
 * - Empty sheet: writes the full header row.
 * - Existing sheet shorter than the schema: appends the missing trailing
 *   headers without disturbing existing columns. This lets us add columns
 *   to a tab in code without manual sheet edits or data loss.
 * - Existing sheet at or beyond schema width: leaves it alone.
 */
function ensureHeaders_(tabName, headers) {
  var sheet = getSheet_(tabName);
  var lastCol = sheet.getLastColumn();

  if (lastCol === 0) {
    // Brand-new sheet
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  // Check whether row 1 within the existing range is actually populated
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var isEmpty = existing.every(function(cell) { return cell === ''; });
  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  // Schema migration: add any missing trailing headers
  if (headers.length > lastCol) {
    var missing = headers.slice(lastCol);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold');
  }

  return sheet;
}

/**
 * Initialize all sheet tabs with headers. Run once during setup.
 */
function initializeAllSheets() {
  ensureHeaders_(TAB_LEADS, LEADS_HEADERS);
  ensureHeaders_(TAB_CUSTOMERS, CUSTOMERS_HEADERS);
  ensureHeaders_(TAB_INSTALLS, INSTALLS_HEADERS);
  ensureHeaders_(TAB_EQUIPMENT, EQUIPMENT_HEADERS);
  ensureHeaders_(TAB_SUPPORT, SUPPORT_HEADERS);
  ensureHeaders_(TAB_WEBHOOK_LOG, WEBHOOK_LOG_HEADERS);
  ensureHeaders_(TAB_BROADCAST_LOG, BROADCAST_LOG_HEADERS);

  var dashSheet = getSheet_(TAB_DASHBOARD);
  var firstCell = dashSheet.getRange('A1').getValue();
  if (firstCell === '') {
    setupDashboardFormulas_();
  }
}

// ── Row Finders ────────────────────────────────────────────

/**
 * Find a row in a sheet by matching a value in a specific column.
 * Returns the 1-based row number, or null if not found.
 */
function findRow_(tabName, colIndex, value) {
  if (!value) return null;
  var sheet = getSheet_(tabName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  var searchVal = String(value).toLowerCase().trim();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === searchVal) {
      return i + 2; // 1-based, skip header
    }
  }
  return null;
}

/**
 * Find a lead row using triple-redundant matching.
 * Priority: row_key > Stripe Customer ID > email
 */
function findLeadRow_(rowKey, custId, email) {
  var row = findRow_(TAB_LEADS, L.ROW_KEY, rowKey);
  if (row) return row;
  row = findRow_(TAB_LEADS, L.STRIPE_CUST_ID, custId);
  if (row) return row;
  return findRow_(TAB_LEADS, L.EMAIL, email);
}

/**
 * Find a customer row using double matching.
 * Priority: Stripe Customer ID > email
 */
function findCustomerRow_(custId, email) {
  var row = findRow_(TAB_CUSTOMERS, C_.STRIPE_CUST_ID, custId);
  if (row) return row;
  return findRow_(TAB_CUSTOMERS, C_.EMAIL, email);
}

// ── Row Read/Write ─────────────────────────────────────────

/**
 * Read an entire row from a sheet tab. Returns an array of values.
 */
function readRow_(tabName, rowNum, numCols) {
  var sheet = getSheet_(tabName);
  return sheet.getRange(rowNum, 1, 1, numCols).getValues()[0];
}

/**
 * Write a value to a specific cell in a sheet tab.
 */
function writeCell_(tabName, rowNum, colIndex, value) {
  var sheet = getSheet_(tabName);
  sheet.getRange(rowNum, colIndex).setValue(value);
}

/**
 * Append a row to a sheet tab.
 */
function appendRow_(tabName, values) {
  var sheet = getSheet_(tabName);
  sheet.appendRow(values);
  return sheet.getLastRow();
}

/**
 * Get all data from a sheet tab (including headers).
 * Returns a 2D array.
 */
function getAllData_(tabName) {
  var sheet = getSheet_(tabName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  return sheet.getRange(1, 1, lastRow, lastCol).getValues();
}

/**
 * Get data rows only (skip header). Returns array of objects keyed by header names.
 */
function getDataAsObjects_(tabName) {
  var data = getAllData_(tabName);
  if (data.length < 2) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    obj._rowNum = i + 1;
    rows.push(obj);
  }
  return rows;
}

// ── Lead → Customer Promotion ──────────────────────────────

/**
 * Create a customer row from a lead row.
 * Called when checkout.session.completed fires.
 */
function createCustomerFromLead_(leadRowNum, stripeSubId, subStatus) {
  var leadData = readRow_(TAB_LEADS, leadRowNum, LEADS_HEADERS.length);

  // Look up the monthly price from Stripe
  var monthlyPrice = '';
  try {
    if (stripeSubId) {
      var sub = stripeGet_('/v1/subscriptions/' + stripeSubId);
      if (sub && sub.items && sub.items.data && sub.items.data[0]) {
        monthlyPrice = (sub.items.data[0].price.unit_amount / 100).toFixed(2);
      }
    }
  } catch (e) {
    Logger.log('Could not fetch subscription price: ' + e.message);
  }

  var customerRow = [
    leadData[L.STRIPE_CUST_ID - 1],  // Stripe Customer ID
    leadData[L.FULL_NAME - 1],        // Full Name
    leadData[L.EMAIL - 1],            // Email
    leadData[L.PHONE - 1],            // Phone
    leadData[L.ADDRESS - 1] + ', ' + leadData[L.CITY - 1] + ', ' + leadData[L.STATE - 1] + ' ' + leadData[L.ZIP - 1], // Address
    leadData[L.PLAN - 1],             // Plan
    stripeSubId,                       // Stripe Subscription ID
    subStatus || 'active',             // Subscription Status
    monthlyPrice,                      // Monthly Price (from Stripe)
    '',                                // Portal Link (generated separately)
    new Date(),                        // Signup Date
    new Date(),                        // Last Payment Date
    'checkout.session.completed',      // Last Event
    leadData[L.ROW_KEY - 1],          // Row Key
    '',                                // Notes
    'auto'                             // Billing Method (Stripe charges card automatically)
  ];

  // Make sure the sheet has the Billing Method column before writing
  ensureHeaders_(TAB_CUSTOMERS, CUSTOMERS_HEADERS);
  return appendRow_(TAB_CUSTOMERS, customerRow);
}

/**
 * Create an install row from a lead row.
 * Called when checkout.session.completed fires.
 *
 * In the new survey-first flow, the install is already physically done
 * before the customer pays. Pass alreadyComplete=true to mark the install
 * row as "Completed" (with today as the completion date and the lead's
 * confirmed install date as the scheduled date) instead of "Pending".
 */
function createInstallFromLead_(leadRowNum, alreadyComplete) {
  var leadData = readRow_(TAB_LEADS, leadRowNum, LEADS_HEADERS.length);
  var requestedDate = leadData[L.REQUESTED_INSTALL_DATE - 1];
  var scheduled = (requestedDate && String(requestedDate).toUpperCase() !== 'ASAP') ? requestedDate : '';

  var status = alreadyComplete ? 'Completed' : 'Pending';
  var completionDate = alreadyComplete ? new Date() : '';
  var installRow = [
    leadData[L.FULL_NAME - 1],        // Customer Name
    leadData[L.EMAIL - 1],            // Email
    leadData[L.ADDRESS - 1] + ', ' + leadData[L.CITY - 1] + ', ' + leadData[L.STATE - 1] + ' ' + leadData[L.ZIP - 1], // Address
    leadData[L.PLAN - 1],             // Plan
    leadData[L.INSTALL_PREF - 1],     // Requested Preference (legacy field)
    scheduled,                         // Scheduled Date
    '',                                // Technician
    '',                                // Equipment Assigned
    status,                            // Status
    completionDate,                    // Completion Date
    ''                                 // Notes
  ];

  return appendRow_(TAB_INSTALLS, installRow);
}

// ── Support Tickets ────────────────────────────────────────

/**
 * Generate the next ticket number.
 */
function nextTicketNumber_() {
  var sheet = getSheet_(TAB_SUPPORT);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 'T-001';
  var lastTicket = sheet.getRange(lastRow, 1).getValue();
  var num = parseInt(String(lastTicket).replace('T-', ''), 10) || 0;
  return 'T-' + String(num + 1).padStart(3, '0');
}

/**
 * Create a new support ticket.
 */
function createSupportTicket_(customerName, email, category, description) {
  var ticketRow = [
    nextTicketNumber_(),
    customerName,
    email,
    new Date(),
    category,
    description,
    'Open',
    '',
    '',
    ''
  ];
  return appendRow_(TAB_SUPPORT, ticketRow);
}
