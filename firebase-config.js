// Replace with your Firebase config
const firebaseConfig = {
    apiKey: "AIzaSyYOUR_API_KEY_HERE",
    authDomain: "kinaflix-tv.firebaseapp.com",
    projectId: "kinaflix-tv",
    storageBucket: "kinaflix-tv.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Initialize Firebase
try {
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
} catch (error) {
    console.error('Firebase initialization error:', error);
}

// Export for use in other files
const db = firebase.firestore();
