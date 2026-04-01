const admin = require("firebase-admin");

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Use service account from environment variable (prod)
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Use local JSON file (dev)
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

// Point to emulators if USE_EMULATOR is set
if (process.env.USE_EMULATOR === "true") {
  db.settings({
    host: "localhost:9090",
    ssl: false,
    projectId: "demo-project",
  });

  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  console.log("Using Firebase Emulators");
}

module.exports = { db, auth, admin };