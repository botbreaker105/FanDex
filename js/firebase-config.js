// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  addDoc, 
  doc, 
  getDoc 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAmftI-0auyp_r4fCmafphxF6P8DhtWPhU",
  authDomain: "fandex-b0tbr.firebaseapp.com",
  projectId: "fandex-b0tbr",
  storageBucket: "fandex-b0tbr.firebasestorage.app",
  messagingSenderId: "509616063241",
  appId: "1:509616063241:web:84b7a915562b2a8cee89d8",
  measurementId: "G-WBC8N2TQXR"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);
export const db = getFirestore(app);

// Helper function to test connection
export async function fetchEntries() {
  const querySnapshot = await getDocs(collection(db, "entries"));
  const entries = [];
  querySnapshot.forEach((doc) => {
    entries.push({ id: doc.id, ...doc.data() });
  });
  return entries;
}