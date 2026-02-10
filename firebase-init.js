// firebase-init.js (Compat SDK)
(function () {
  if (!window.firebase) {
    console.error("Firebase SDK not loaded");
    return;
  }

  const firebaseConfig = {
    apiKey: "AIzaSyBZFAk80TlzESxnFNlG0uonVyLj3bQ3PRo",
    authDomain: "wingo-app-f68dd.firebaseapp.com",
    projectId: "wingo-app-f68dd",
    storageBucket: "wingo-app-f68dd.firebasestorage.app",
    messagingSenderId: "533037771285",
    appId: "1:533037771285:web:d72372f86108a8379dbc1c",
    measurementId: "G-RJ1XX4FX3W"
  };

  try {
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    window.db = firebase.firestore();
  } catch (e) {
    console.error("Firebase init error:", e);
  }
})();
