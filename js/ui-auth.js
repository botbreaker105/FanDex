"use strict";

import { signIn, signUp, logOut } from "./auth.js";

const overlay = document.getElementById("authOverlay");
const openBtn = document.getElementById("openLoginBtn");
const closeBtn = document.getElementById("closeAuthForm");
const logoutBtn = document.getElementById("logoutBtn");

const form = document.getElementById("authForm");
const titleEl = document.getElementById("authFormTitle");
const nameField = document.getElementById("authNameField");
const nameInput = document.getElementById("auth-name");
const emailInput = document.getElementById("auth-email");
const passwordInput = document.getElementById("auth-password");
const errorEl = document.getElementById("authError");
const submitBtn = document.getElementById("authSubmitBtn");

const tabSignIn = document.getElementById("authTabSignIn");
const tabSignUp = document.getElementById("authTabSignUp");

let mode = "signin"; // "signin" | "signup"

// ================= FRIENDLY ERROR MESSAGES =================
function friendlyAuthError(err) {
  const code = err && err.code ? String(err.code) : "";
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password is incorrect.";
    case "auth/email-already-in-use":
      return "An account already exists with that email — try logging in instead.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/too-many-requests":
      return "Too many attempts — please wait a moment and try again.";
    default:
      return (err && err.message) ? err.message : "Something went wrong. Please try again.";
  }
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = message ? "block" : "none";
}

function clearError() {
  showError("");
}

// ================= MODE SWITCHING =================
function setMode(nextMode) {
  mode = nextMode;
  clearError();

  const isSignUp = mode === "signup";
  if (nameField) nameField.style.display = isSignUp ? "block" : "none";
  if (titleEl) titleEl.textContent = isSignUp ? "Sign Up" : "Log In";
  if (submitBtn) submitBtn.textContent = isSignUp ? "Sign Up" : "Log In";

  if (tabSignIn) tabSignIn.classList.toggle("active", !isSignUp);
  if (tabSignUp) tabSignUp.classList.toggle("active", isSignUp);
}

if (tabSignIn) tabSignIn.addEventListener("click", () => setMode("signin"));
if (tabSignUp) tabSignUp.addEventListener("click", () => setMode("signup"));

// ================= OPEN / CLOSE =================
function openModal(initialMode = "signin") {
  setMode(initialMode);
  if (form) form.reset();
  clearError();
  if (overlay) overlay.classList.add("open");
}

function closeModal() {
  if (overlay) overlay.classList.remove("open");
}

if (openBtn) openBtn.addEventListener("click", () => openModal("signin"));
if (closeBtn) closeBtn.addEventListener("click", closeModal);
if (overlay) {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
}

// ================= SUBMIT =================
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    const email = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";
    const displayName = (nameInput?.value || "").trim();

    if (!email || !password) {
      showError("Please fill in email and password.");
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = mode === "signup" ? "Signing up…" : "Logging in…";

    try {
      if (mode === "signup") {
        await signUp(email, password, displayName);
      } else {
        await signIn(email, password);
      }
      closeModal();
    } catch (err) {
      console.error("❌ Auth error:", err);
      showError(friendlyAuthError(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

// ================= LOGOUT =================
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await logOut();
    } catch (err) {
      console.error("❌ Failed to log out:", err);
    }
  });
}

// Expose for other scripts/debugging if needed
window.FanDexAuthUI = { openModal, closeModal };
