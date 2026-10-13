// ==========================================
//  MatchBoard - Firebase Configuration & Sync
// ==========================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js';
import {
  getDatabase,
  ref,
  onValue,
  set,
  get
} from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-database.js';

// 既存プロジェクト (nakanofa-tournament-2026) 設定
const firebaseConfig = {
  apiKey: 'AIzaSyAlLjNSyjt_UsqK9tKYkScV7hwpO1GZqJc',
  authDomain: 'nakanofa-tournament-2026.firebaseapp.com',
  databaseURL: 'https://nakanofa-tournament-2026-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'nakanofa-tournament-2026',
  storageBucket: 'nakanofa-tournament-2026.firebasestorage.app',
  messagingSenderId: '210102522297',
  appId: '1:210102522297:web:a0741e599c9358dd02e668',
};

// 初期管理者メールアドレス（常時アクセス許可）
export const DEFAULT_ADMIN_EMAIL = 'matsuo.wtr@gmail.com';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// 認証関数
export async function loginWithGoogle() {
  return await signInWithPopup(auth, googleProvider);
}

export async function loginWithGoogleRedirect() {
  return await signInWithRedirect(auth, googleProvider);
}

export async function checkRedirectResult() {
  return await getRedirectResult(auth);
}

export async function logoutUser() {
  return await signOut(auth);
}

// データベース参照パス
export const DB_PATHS = {
  DATA: 'matchboard/data',
  ALLOWED_USERS: 'matchboard/allowed_users',
  META: 'matchboard/meta',
  BACKUP: 'matchboard/backup'
};
