/**
 * Dashboard.gs -- Dashboard tab setup with summary formulas
 * NenanaWISP Billing Platform
 */

/**
 * Set up the Dashboard tab with summary formulas.
 * Run once during initial setup via initializeAllSheets().
 */
function setupDashboardFormulas_() {
  var sheet = getSheet_(TAB_DASHBOARD);

  // Clear existing content
  sheet.clear();

  // Title
  sheet.getRange('A1').setValue('Nenana WISP Dashboard').setFontSize(16).setFontWeight('bold');
  sheet.getRange('A2').setValue('Auto-updated from Customers, Leads, Installs, and Support tabs').setFontColor('#6b7280');

  // ── Subscriber Summary ──────────────────
  sheet.getRange('A4').setValue('Subscriber Summary').setFontSize(13).setFontWeight('bold');

  sheet.getRange('A5').setValue('Active Subscribers');
  sheet.getRange('B5').setFormula('=COUNTIF(Customers!H:H,"active")');

  sheet.getRange('A6').setValue('Past Due');
  sheet.getRange('B6').setFormula('=COUNTIF(Customers!H:H,"past_due")');
  sheet.getRange('B6').setFontColor('#c0392b');

  sheet.getRange('A7').setValue('Canceled');
  sheet.getRange('B7').setFormula('=COUNTIF(Customers!H:H,"canceled")');

  sheet.getRange('A8').setValue('Total Customers (all time)');
  sheet.getRange('B8').setFormula('=COUNTA(Customers!A2:A)');

  // ── Revenue ─────────────────────────────
  sheet.getRange('A10').setValue('Revenue').setFontSize(13).setFontWeight('bold');

  sheet.getRange('A11').setValue('Monthly Recurring Revenue (MRR)');
  sheet.getRange('B11').setFormula('=SUMPRODUCT((Customers!H2:H="active")*(Customers!I2:I))');
  sheet.getRange('B11').setNumberFormat('$#,##0.00');

  sheet.getRange('A12').setValue('Avg Revenue / Customer');
  sheet.getRange('B12').setFormula('=IF(B5>0,B11/B5,0)');
  sheet.getRange('B12').setNumberFormat('$#,##0.00');

  // ── Plan Breakdown ──────────────────────
  sheet.getRange('A14').setValue('Plan Breakdown (Active)').setFontSize(13).setFontWeight('bold');

  sheet.getRange('A15').setValue('Residential 50/10 Mbps');
  sheet.getRange('B15').setFormula('=COUNTIFS(Customers!H:H,"active",Customers!F:F,"Residential 50/10 Mbps")');

  sheet.getRange('A16').setValue('Residential 100/20 Mbps');
  sheet.getRange('B16').setFormula('=COUNTIFS(Customers!H:H,"active",Customers!F:F,"Residential 100/20 Mbps")');

  sheet.getRange('A17').setValue('Business 100/100 Mbps');
  sheet.getRange('B17').setFormula('=COUNTIFS(Customers!H:H,"active",Customers!F:F,"Business 100/100 Mbps")');

  // ── Pipeline ────────────────────────────
  sheet.getRange('A19').setValue('Pipeline').setFontSize(13).setFontWeight('bold');

  sheet.getRange('A20').setValue('Pending Leads (Checkout Sent)');
  sheet.getRange('B20').setFormula('=COUNTIF(Leads!R:R,"Checkout Sent")');

  sheet.getRange('A21').setValue('Pending Installs');
  sheet.getRange('B21').setFormula('=COUNTIFS(Installs!I:I,"Pending")');

  sheet.getRange('A22').setValue('Scheduled Installs');
  sheet.getRange('B22').setFormula('=COUNTIFS(Installs!I:I,"Scheduled")');

  // ── Support ─────────────────────────────
  sheet.getRange('A24').setValue('Support').setFontSize(13).setFontWeight('bold');

  sheet.getRange('A25').setValue('Open Tickets');
  sheet.getRange('B25').setFormula('=COUNTIF(Support!G:G,"Open")');

  sheet.getRange('A26').setValue('In Progress Tickets');
  sheet.getRange('B26').setFormula('=COUNTIF(Support!G:G,"In Progress")');

  sheet.getRange('A27').setValue('Resolved (all time)');
  sheet.getRange('B27').setFormula('=COUNTIF(Support!G:G,"Resolved")');

  // ── Formatting ──────────────────────────
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 150);
  sheet.getRange('B5:B8').setFontWeight('bold').setFontSize(14);
  sheet.getRange('B11:B12').setFontWeight('bold').setFontSize(14);
  sheet.getRange('B15:B17').setFontWeight('bold');
  sheet.getRange('B20:B22').setFontWeight('bold');
  sheet.getRange('B25:B27').setFontWeight('bold');
}
