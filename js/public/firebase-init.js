// public/js/firebase-init.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// firebaseClientConfig is passed from the EJS template via a global variable
const firebaseConfig = window.firebaseClientConfig;

// Initialize Firebase client SDK if not already initialized
let app;
try {
  if (!window.firebaseAppInstance) {
    // Prevent re-initialization if imported multiple times
    app = initializeApp(firebaseConfig);
    window.firebaseAppInstance = app; // Store it globally if needed elsewhere
  } else {
    app = window.firebaseAppInstance;
  }
} catch (e) {
  // Handle specific error if app is already initialized in a different way
  console.warn("Firebase app already initialized. Using existing instance.", e);
  app = window.firebaseAppApp; // Assuming it's already available
}

export const auth = getAuth(app);
export default app;
