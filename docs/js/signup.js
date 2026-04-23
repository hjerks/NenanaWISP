/**
 * signup.js -- Multi-step signup flow for NenanaWISP
 *
 * Step 1: customer info form
 * Step 2: coverage check (geocodes the address, snaps to the predicted RSSI grid)
 * Step 3: install date picker (ASAP or specific weekday, 2-14 days out)
 *
 * On submit, creates a "Survey Requested" lead. NO payment is collected here -
 * the tech does that after the install is complete.
 */

// ── Configuration ──────────────────────────────────────────
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwZV3Gljv5z5-RrOpM9eo3jDfQ7L_5E9fJYiDmISXli__tX_NWeW4i3zoGRxC08Ykr_4g/exec';
var COVERAGE_JSON_URL = 'coverage/nenana_coverage.json';

// Cached coverage data so we don't refetch between back/forward steps.
var _coverageData = null;
var _coverageFetchPromise = null;
var _currentStep = 1;

// ── Plan Selection ─────────────────────────────────────────

function selectPlan(button) {
  var plan = button.getAttribute('data-plan');
  var planSelect = document.getElementById('plan');
  if (planSelect && plan) {
    planSelect.value = plan;
  }
  var signupSection = document.getElementById('signup');
  if (signupSection) {
    signupSection.scrollIntoView({ behavior: 'smooth' });
  }
  if (planSelect) {
    planSelect.style.borderColor = '#27ae60';
    planSelect.style.boxShadow = '0 0 0 3px rgba(39,174,96,0.2)';
    setTimeout(function() {
      planSelect.style.borderColor = '';
      planSelect.style.boxShadow = '';
    }, 2000);
  }
}

// ── Step 1 validation ──────────────────────────────────────

function validateStep1() {
  var valid = true;
  clearErrors();

  var name = document.getElementById('full_name').value.trim();
  if (!name) { showError('full_name', 'err-name'); valid = false; }

  var email = document.getElementById('email').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('email', 'err-email'); valid = false;
  }

  var plan = document.getElementById('plan').value;
  if (!plan) { showError('plan', 'err-plan'); valid = false; }

  var address = document.getElementById('address').value.trim();
  if (!address) { showError('address', 'err-address'); valid = false; }

  var tos = document.getElementById('tos_agreed');
  if (tos && !tos.checked) { showError('tos_agreed', 'err-tos'); valid = false; }

  return valid;
}

function showError(inputId, errorId) {
  var input = document.getElementById(inputId);
  var error = document.getElementById(errorId);
  if (input) input.classList.add('error');
  if (error) error.style.display = 'block';
}

function clearErrors() {
  var errors = document.querySelectorAll('.form-error');
  for (var i = 0; i < errors.length; i++) errors[i].style.display = 'none';
  var inputs = document.querySelectorAll('.error');
  for (var j = 0; j < inputs.length; j++) inputs[j].classList.remove('error');
}

// ── Step navigation ────────────────────────────────────────

function showStep(n) {
  _currentStep = n;
  for (var i = 1; i <= 3; i++) {
    var panel = document.getElementById('step-' + i);
    if (panel) panel.style.display = (i === n) ? '' : 'none';
    var indicator = document.querySelector('.step-item[data-step="' + i + '"]');
    if (indicator) {
      indicator.classList.toggle('active', i === n);
      indicator.classList.toggle('done', i < n);
    }
  }
  var signupSection = document.getElementById('signup');
  if (signupSection) signupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Coverage check (Step 2) ────────────────────────────────

function loadCoverageData() {
  if (_coverageData) return Promise.resolve(_coverageData);
  if (_coverageFetchPromise) return _coverageFetchPromise;
  _coverageFetchPromise = fetch(COVERAGE_JSON_URL, { cache: 'no-cache' })
    .then(function(r) {
      if (!r.ok) throw new Error('coverage data unavailable');
      return r.json();
    })
    .then(function(data) { _coverageData = data; return data; });
  return _coverageFetchPromise;
}

function geocodeAddressPublic(address) {
  var url = APPS_SCRIPT_URL + '?action=public_geocode&address=' + encodeURIComponent(address);
  return fetch(url, { redirect: 'follow' })
    .then(function(r) { return r.text(); })
    .then(function(t) {
      try { return JSON.parse(t); } catch (e) { throw new Error('bad geocode response'); }
    });
}

function classifyRssi(rssi, thresholds) {
  if (rssi == null) return { cls: 'unknown', label: 'Unknown', desc: 'We could not place this address on the coverage map.' };
  if (rssi >= thresholds.good_min_dbm) {
    return {
      cls: 'good',
      label: 'Likely Good Coverage',
      desc: 'Our model predicts a strong signal at this address.'
    };
  }
  if (rssi >= thresholds.marginal_min_dbm) {
    return {
      cls: 'marginal',
      label: 'Marginal Coverage',
      desc: 'Signal at this address may be borderline. A site survey will confirm.'
    };
  }
  return {
    cls: 'bad',
    label: 'Likely No Signal',
    desc: 'Our model predicts a weak or no signal here. We may not be able to install, but we will still review and let you know.'
  };
}

function runCoverageCheck() {
  var box = document.getElementById('coverage-result');
  var nextBtn = document.getElementById('step2-next-btn');
  if (!box) return;

  box.className = 'coverage-result loading';
  box.innerHTML = '<p>Looking up your address and checking coverage&hellip;</p>';

  var address = document.getElementById('address').value.trim();
  var city = document.getElementById('city').value.trim();
  var state = document.getElementById('state').value.trim();
  var zip = document.getElementById('zip').value.trim();
  var fullAddress = [address, city, state, zip].filter(Boolean).join(', ');

  Promise.all([loadCoverageData(), geocodeAddressPublic(fullAddress)])
    .then(function(results) {
      var cov = results[0];
      var geo = results[1];

      if (geo.error || !isFinite(geo.lat) || !isFinite(geo.lon)) {
        // Make diagnostics visible in console + UI so we can tell whether
        // it's a missing API key, a deployment that hasn't been refreshed,
        // a quota issue, or a genuine no-match address.
        console.warn('[signup] geocode response:', geo);
        var why;
        if (geo.error === 'no_key') {
          why = 'The Google Geocoding API key is not configured on the server yet.';
        } else if (geo.error === 'no_result') {
          why = 'Google could not find that address (status: ' + (geo.status || 'unknown') + '). Please double-check the street, city, and ZIP.';
        } else if (geo.error === 'fetch_failed') {
          why = 'The geocoding service is unreachable right now.';
        } else if (geo.status === 'ok' && !geo.lat) {
          // The Apps Script default doGet returned, meaning the new
          // public_geocode endpoint isn't deployed yet.
          why = 'Geocoding endpoint not deployed. The signup will still work; the tech will review your address manually.';
        } else if (geo.error) {
          why = 'Geocoding error: ' + geo.error + (geo.message ? ' (' + geo.message + ')' : '');
        } else {
          why = 'We could not find that address on the map. The tech will still review it.';
        }
        showCoverageResult({
          cls: 'unknown',
          label: 'Could not locate address',
          desc: why
        }, null);
        return;
      }

      var sw = cov.bounds[0], ne = cov.bounds[1];
      var rows = cov.rows, cols = cov.cols;
      var ri = Math.round((ne[0] - geo.lat) / (ne[0] - sw[0]) * (rows - 1));
      var ci = Math.round((geo.lon - sw[1]) / (ne[1] - sw[1]) * (cols - 1));
      var inGrid = (ri >= 0 && ri < rows && ci >= 0 && ci < cols);
      var rssi = inGrid ? cov.rssi_dbm[ri][ci] : null;

      var verdict = classifyRssi(rssi, cov.thresholds);
      showCoverageResult(verdict, rssi);

      // Stash the prediction so the backend tech-notification email includes it.
      var hidden = document.getElementById('coverage_prediction');
      if (hidden) {
        hidden.value = verdict.label + (rssi != null ? ' (' + rssi.toFixed(1) + ' dBm)' : '');
      }
    })
    .catch(function(err) {
      showCoverageResult({
        cls: 'unknown',
        label: 'Coverage check unavailable',
        desc: 'We could not run the coverage check right now. Your tech will still review your request.'
      }, null);
    })
    .then(function() {
      if (nextBtn) nextBtn.disabled = false;
    });
}

function showCoverageResult(verdict, rssi) {
  var box = document.getElementById('coverage-result');
  if (!box) return;
  box.className = 'coverage-result ' + verdict.cls;
  var rssiLine = (rssi != null)
    ? '<p class="cov-rssi">Predicted signal: <strong>' + rssi.toFixed(1) + ' dBm</strong></p>'
    : '';
  box.innerHTML =
    '<div class="cov-badge cov-' + verdict.cls + '">' + verdict.label + '</div>' +
    '<p>' + verdict.desc + '</p>' +
    rssiLine;
}

// ── Install date picker (Step 3) ───────────────────────────

function refreshDateChoiceUI() {
  var radios = document.getElementsByName('install_date_choice');
  var row = document.getElementById('date-input-row');
  var choice = 'ASAP';
  for (var i = 0; i < radios.length; i++) if (radios[i].checked) choice = radios[i].value;
  if (row) row.style.display = (choice === 'specific') ? '' : 'none';

  if (choice === 'ASAP') {
    document.getElementById('requested_install_date').value = 'ASAP';
  }
}

function getMinInstallDate() {
  // 2 weekdays from today
  var d = new Date();
  var added = 0;
  while (added < 2) {
    d.setDate(d.getDate() + 1);
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function getMaxInstallDate() {
  // 14 calendar days from today (cap; user must still pick a weekday)
  var d = new Date();
  d.setDate(d.getDate() + 14);
  return d;
}

function fmtYMD(d) {
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + dd;
}

function validateInstallDate() {
  var radios = document.getElementsByName('install_date_choice');
  var choice = 'ASAP';
  for (var i = 0; i < radios.length; i++) if (radios[i].checked) choice = radios[i].value;

  if (choice === 'ASAP') {
    document.getElementById('requested_install_date').value = 'ASAP';
    return true;
  }

  var input = document.getElementById('install_date');
  var err = document.getElementById('err-date');
  if (!input.value) { err.style.display = 'block'; return false; }

  // Parse as a local date (avoid TZ shift from new Date('YYYY-MM-DD') which is UTC).
  var parts = input.value.split('-');
  var picked = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  var dow = picked.getDay();
  if (dow === 0 || dow === 6) { err.style.display = 'block'; return false; }

  var min = getMinInstallDate();
  var max = getMaxInstallDate();
  // Strip times for comparison
  min.setHours(0,0,0,0); max.setHours(0,0,0,0); picked.setHours(0,0,0,0);
  if (picked < min || picked > max) { err.style.display = 'block'; return false; }

  err.style.display = 'none';
  document.getElementById('requested_install_date').value = input.value;
  return true;
}

// ── Form submission ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  var form = document.getElementById('signup-form');
  if (!form) return;

  // Step 1 -> 2
  document.getElementById('step1-next-btn').addEventListener('click', function() {
    if (!validateStep1()) return;
    showStep(2);
    runCoverageCheck();
  });

  // Step 2 nav
  document.getElementById('step2-back-btn').addEventListener('click', function() { showStep(1); });
  document.getElementById('step2-next-btn').addEventListener('click', function() {
    initInstallDateInput();
    showStep(3);
  });

  // Step 3 date picker
  var dateRadios = document.getElementsByName('install_date_choice');
  for (var i = 0; i < dateRadios.length; i++) {
    dateRadios[i].addEventListener('change', refreshDateChoiceUI);
  }
  refreshDateChoiceUI();
  document.getElementById('step3-back-btn').addEventListener('click', function() { showStep(2); });

  // Final submit
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (_currentStep !== 3) return;
    if (!validateStep1()) { showStep(1); return; }
    if (!validateInstallDate()) return;

    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
      showMessage('error', 'Service signup is not yet configured. Please contact us directly.');
      return;
    }

    var btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting...';

    var formData = new FormData(form);
    var params = new URLSearchParams(formData);

    fetch(APPS_SCRIPT_URL + '?source=signup_form', {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'follow'
    })
    .then(function(response) { return response.text(); })
    .then(function(text) {
      try {
        var data = JSON.parse(text);
        if (data.success) {
          showSuccessScreen();
        } else {
          throw new Error(data.error || 'Signup failed');
        }
      } catch (parseErr) {
        throw new Error('Unexpected response from server. Please try again.');
      }
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.innerHTML = 'Submit Request';
      showMessage('error', 'Something went wrong: ' + err.message + '. Please try again or contact us.');
    });
  });

  // Clear field errors on input
  var inputs = form.querySelectorAll('input, select, textarea');
  for (var k = 0; k < inputs.length; k++) {
    inputs[k].addEventListener('input', function() {
      this.classList.remove('error');
      var errorEl = this.parentElement.querySelector('.form-error');
      if (errorEl) errorEl.style.display = 'none';
    });
  }
});

function initInstallDateInput() {
  var input = document.getElementById('install_date');
  if (!input) return;
  input.min = fmtYMD(getMinInstallDate());
  input.max = fmtYMD(getMaxInstallDate());
}

function showSuccessScreen() {
  var form = document.getElementById('signup-form');
  if (!form) return;
  form.innerHTML =
    '<div class="success-screen">' +
    '  <div class="cov-badge cov-good" style="font-size:1rem;">Request received</div>' +
    '  <h3 style="margin:16px 0 8px;color:#1a5276;">Thanks - we got your request!</h3>' +
    '  <p>Our network tech will review your address, confirm a date (or propose a different one), ' +
    '  and let you know about a site survey if needed. Look for an email from us soon.</p>' +
    '  <p style="margin-top:14px;color:#374151;"><strong>You won\'t be charged anything yet.</strong> ' +
    '  Payment isn\'t collected until your install is complete.</p>' +
    '</div>';
  document.getElementById('signup').scrollIntoView({ behavior: 'smooth' });
}

// ── Message Display ────────────────────────────────────────

function showMessage(type, text) {
  var msg = document.getElementById('form-message');
  if (!msg) return;
  msg.className = 'form-message ' + type;
  msg.textContent = text;
  msg.style.display = 'block';
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
