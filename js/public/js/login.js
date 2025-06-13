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

    loginBtn.disabled = true;
    loginBtn.textContent = "Logging in...";
    errorMessageSpan.textContent = "";

    try {
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );
      const idToken = await userCredential.user.getIdToken();

      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: idToken }),
      });
      console.log(response);

      const data = await response.json();
      console.log(data);


      if (data.status === "success") {
        window.location.href = "/";
      } else {
        errorMessageSpan.textContent =
          data.error || "Login failed. Please try again.";
      }
      window.location.href = "/";
    } catch (error) {
      console.error("Firebase/Backend login error:", error);
      let displayMessage = "An unexpected error occurred. Please try again.";
      if (error.code) {
        switch (error.code) {
          case "auth/user-not-found":
          case "auth/wrong-password":
          case "auth/invalid-credential":
            displayMessage = "Invalid email or password.";
            break;
          case "auth/invalid-email":
            displayMessage = "Invalid email format.";
            break;
          case "auth/user-disabled":
            displayMessage = "Your account has been disabled.";
            break;
          default:
            displayMessage = error.message;
        }
      }
      errorMessageSpan.textContent = displayMessage;
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Login";
    }
  });
});
