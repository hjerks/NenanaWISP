/**
 * signup.js -- Form validation and submission for NenanaWISP signup page
 *
 * CONFIGURATION: Set APPS_SCRIPT_URL to your deployed Apps Script web app URL.
 * This is the ONLY config value in the frontend. No secrets here.
 */

// ── Configuration ──────────────────────────────────────────
// Replace this with your deployed Apps Script web app URL after deployment
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbywAMVqrh0CdLEILWGJz62XVA8n-VWwcTWjGQ67ULV-PO143gEiqPfE3_q6Y3jUChud/exec';

// ── Plan Selection ─────────────────────────────────────────

function selectPlan(button) {
  var plan = button.getAttribute('data-plan');
  var planSelect = document.getElementById('plan');
  if (planSelect && plan) {
    planSelect.value = plan;
  }
  // Scroll to signup form
  var signupSection = document.getElementById('signup');
  if (signupSection) {
    signupSection.scrollIntoView({ behavior: 'smooth' });
  }
  // Brief highlight effect on the plan dropdown
  if (planSelect) {
    planSelect.style.borderColor = '#27ae60';
    planSelect.style.boxShadow = '0 0 0 3px rgba(39,174,96,0.2)';
    setTimeout(function() {
      planSelect.style.borderColor = '';
      planSelect.style.boxShadow = '';
    }, 2000);
  }
}

// ── Form Validation ────────────────────────────────────────

function validateForm() {
  var valid = true;
  clearErrors();

  // Full name
  var name = document.getElementById('full_name').value.trim();
  if (!name) {
    showError('full_name', 'err-name');
    valid = false;
  }

  // Email
  var email = document.getElementById('email').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('email', 'err-email');
    valid = false;
  }

  // Plan
  var plan = document.getElementById('plan').value;
  if (!plan) {
    showError('plan', 'err-plan');
    valid = false;
  }

  // Address
  var address = document.getElementById('address').value.trim();
  if (!address) {
    showError('address', 'err-address');
    valid = false;
  }

  // TOS
  var tos = document.getElementById('tos_agreed');
  if (tos && !tos.checked) {
    showError('tos_agreed', 'err-tos');
    valid = false;
  }

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
  for (var i = 0; i < errors.length; i++) {
    errors[i].style.display = 'none';
  }
  var inputs = document.querySelectorAll('.error');
  for (var j = 0; j < inputs.length; j++) {
    inputs[j].classList.remove('error');
  }
}

// ── Form Submission ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  var form = document.getElementById('signup-form');
  if (!form) return;

  // Set the form action to the Apps Script URL
  if (APPS_SCRIPT_URL && APPS_SCRIPT_URL !== 'YOUR_APPS_SCRIPT_URL_HERE') {
    form.action = APPS_SCRIPT_URL + '?source=signup_form';
  }

  form.addEventListener('submit', function(e) {
    // Validate before allowing submission
    if (!validateForm()) {
      e.preventDefault();
      return;
    }

    // Check if Apps Script URL is configured
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
      e.preventDefault();
      showMessage('error', 'Service signup is not yet configured. Please contact us directly.');
      return;
    }

    // Show loading state
    var btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting...';

    // Allow the native form POST to proceed (no CORS issues)
    // The form will submit to Apps Script which redirects to Stripe Checkout
  });

  // Clear field errors on input
  var inputs = form.querySelectorAll('input, select, textarea');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('input', function() {
      this.classList.remove('error');
      var errorEl = this.parentElement.querySelector('.form-error');
      if (errorEl) errorEl.style.display = 'none';
    });
  }
});

// ── Message Display ────────────────────────────────────────

function showMessage(type, text) {
  var msg = document.getElementById('form-message');
  if (!msg) return;
  msg.className = 'form-message ' + type;
  msg.textContent = text;
  msg.style.display = 'block';
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
