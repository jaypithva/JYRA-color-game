// jvbet/assets/js/firebase-init.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "PASTE_YOUR_REAL_API_KEY_HERE",
  authDomain: "jvbet-bbf90.firebaseapp.com",
  projectId: "jvbet-bbf90",
  storageBucket: "jvbet-bbf90.appspot.com",
  messagingSenderId: "824871692224",
  appId: "1:824871692224:web:f74baa642b1f43b78aca25"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
