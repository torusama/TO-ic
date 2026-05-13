const fs = require('fs');
const path = require('path');

const configDir = path.join(__dirname, 'assets', 'js');
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}

const configContent = `
export const firebaseConfig = {
  apiKey: "${process.env.FIREBASE_API_KEY || ''}",
  authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
  projectId: "${process.env.FIREBASE_PROJECT_ID || ''}",
  storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET || ''}",
  messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID || ''}",
  appId: "${process.env.FIREBASE_APP_ID || ''}"
};
`;

fs.writeFileSync(path.join(configDir, 'firebase-config.js'), configContent);
console.log('✅ firebase-config.js has been generated successfully from environment variables.');
