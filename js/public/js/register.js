// public/js/register.js
import { auth } from "../firebase-init.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

document.addEventListener("DOMContentLoaded", () => {
  const registerForm = document.getElementById("registerForm");
  const registerBtn = document.getElementById("registerBtn");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const coursesInput = document.getElementById("courses");
  const errorMessageSpan = document.getElementById("errorMessage");

  if (
    !registerForm ||
    !registerBtn ||
    !emailInput ||
    !passwordInput ||
    !coursesInput ||
    !errorMessageSpan
  ) {
    console.error("Register elements not found. Check register.ejs IDs.");
    return;
  }

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    const courses = coursesInput.value.trim();

    if (!email || !password) {
      errorMessageSpan.textContent = "Please enter email and password.";
      return;
    }
    if (password.length < 6) {
      errorMessageSpan.textContent =
        "Password must be at least 6 characters long.";
      return;
    }

    registerBtn.disabled = true;
    registerBtn.textContent = "...";
    errorMessageSpan.textContent = "";

    try {
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      const idToken = await userCredential.user.getIdToken(); // Get ID token

      const response = await fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, courses }), // Send idToken instead of email
      });

      const data = await response.json();

      if (response.ok && data.status === "success") {
        window.location.href = "/";
      } else {
        errorMessageSpan.textContent =
          data.error || "Registration failed on server. Please try again.";
      }
    } catch (error) {
      console.error("Firebase/Backend registration error:", error);
      let displayMessage = "An unexpected error occurred during registration.";
      if (error.code) {
        switch (error.code) {
          case "auth/email-already-in-use":
            displayMessage = "This email is already registered.";
            break;
          case "auth/invalid-email":
            displayMessage = "Invalid email format.";
            break;
          case "auth/weak-password":
            displayMessage = "Password is too weak (min 6 characters).";
            break;
          default:
            displayMessage = error.message;
        }
      }
      errorMessageSpan.textContent = displayMessage;
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = "Register";
    }
  });
});
