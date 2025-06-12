// public/js/register.js
import { auth } from "../firebase-init.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

document.addEventListener("DOMContentLoaded", () => {
  const registerForm = document.getElementById("registerForm"); // Changed from button to form ID
  const registerBtn = document.getElementById("registerBtn"); // Button within the form
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
    // Listen to form submit
    e.preventDefault(); // Prevent default form submission

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

    // --- Loading State Start ---
    registerBtn.disabled = true;
    registerBtn.textContent = "Registering...";
    errorMessageSpan.textContent = ""; // Clear previous errors
    // --- Loading State End ---

    try {
      // First, create user with Firebase Auth (client-side)
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      const user = userCredential.user;

      // Then, send necessary data to your Node.js backend to create lecturer profile
      const response = await fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          courses: courses, // Send courses from client
        }),
      });

      const data = await response.json(); // Backend should return success/error JSON

      if (response.ok && data.status === "success") {
        window.location.href = "/"; // Redirect to home page
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
      } else {
        displayMessage = error.message;
      }
      errorMessageSpan.textContent = displayMessage;
    } finally {
      // --- Loading State End ---
      registerBtn.disabled = false;
      registerBtn.textContent = "Register";
      // --- Loading State End ---
    }
  });
});
