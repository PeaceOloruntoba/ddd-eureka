// public/js/login.js
import { auth } from "../firebase-init.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("loginBtn");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const errorMessageSpan = document.getElementById("errorMessage");

  if (!loginBtn || !emailInput || !passwordInput || !errorMessageSpan) {
    console.error("Login elements not found. Check login.ejs IDs.");
    return;
  }

  loginBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
      errorMessageSpan.textContent = "Please enter both email and password.";
      return;
    }

    // --- Loading State Start ---
    loginBtn.disabled = true;
    loginBtn.textContent = "Logging in...";
    errorMessageSpan.textContent = ""; // Clear previous errors
    // --- Loading State End ---

    try {
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );
      const idToken = await userCredential.user.getIdToken();

      // Send ID token to your Node.js backend for session management
      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: idToken }),
      });

      const data = await response.json();

      if (data.status === "success") {
        window.location.href = "/"; // Redirect to home page
      } else {
        errorMessageSpan.textContent =
          data.error || "Login failed. Please try again.";
      }
    } catch (error) {
      console.error("Firebase/Backend login error:", error);
      let displayMessage = "An unexpected error occurred. Please try again.";
      if (error.code) {
        switch (error.code) {
          case "auth/user-not-found":
          case "auth/wrong-password":
          case "auth/invalid-credential": // More generic since Firebase v10
            displayMessage = "Invalid email or password.";
            break;
          case "auth/invalid-email":
            displayMessage = "Invalid email format.";
            break;
          case "auth/user-disabled":
            displayMessage = "Your account has been disabled.";
            break;
          default:
            displayMessage = error.message; // Fallback to raw message if specific case not handled
        }
      } else {
        displayMessage = error.message;
      }
      errorMessageSpan.textContent = displayMessage;
    } finally {
      // --- Loading State End ---
      loginBtn.disabled = false;
      loginBtn.textContent = "Login";
      // --- Loading State End ---
    }
  });
});
