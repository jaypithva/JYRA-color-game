import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCAFHS_1RjVhyZLwkj26zQPCq0-8S0fSKA",
  authDomain: "jvbet-bbf90.firebaseapp.com",
  projectId: "jvbet-bbf90",
  storageBucket: "jvbet-bbf90.appspot.com",
  messagingSenderId: "824871692224",
  appId: "1:824871692224:web:f74baa642b1f43b78aca25"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
