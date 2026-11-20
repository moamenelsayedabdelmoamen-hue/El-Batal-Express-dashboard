import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  updateProfile,
  updatePassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  reload,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, isFirebaseConfigured, googleProvider } from '../firebase/config';
import { AdminUser } from '../types';
import { COLLECTIONS } from '../services/collections';
import { setCachedGoogleToken } from '../services/googleSheetsService';
import { AdminService } from '../services/adminService';

// List of authorized Super Admin emails who have direct admin access
export const MASTER_ADMIN_EMAIL = 'moamen.elsayed.abdelmoamen@gmail.com';

export const SUPER_ADMIN_EMAILS = [
  MASTER_ADMIN_EMAIL,
  'admin@elbatalexpress.com',
];

export const isSuperAdminEmail = (email?: string | null): boolean => {
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email.trim().toLowerCase());
};

export const isMasterAdminEmail = (email?: string | null): boolean => {
  if (!email) return false;
  return email.trim().toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase();
};

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  isAdmin: boolean;
  isMasterAdmin: boolean;
  claims: Record<string, any> | null;
  login: (email: string, pass: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  loginAsDemoAdmin: () => void;
  updateDisplayName: (newName: string) => Promise<void>;
  changePassword: (newPassword: string) => Promise<{ success: boolean; resetEmailSent?: boolean }>;
  resendVerificationEmail: () => Promise<void>;
  checkVerificationStatus: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [isMasterAdmin, setIsMasterAdmin] = useState<boolean>(false);
  const [claims, setClaims] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    // Remove any legacy browser-only demo session. A localStorage value is never an identity.
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('elbatal_demo_admin_session');
      window.sessionStorage.removeItem('elbatal_explicit_logout');
    }

    // Never grant preview/demo access when Firebase is unavailable or misconfigured.
    if (!isFirebaseConfigured || !auth) {
      setUser(null);
      setIsAdmin(false);
      setIsMasterAdmin(false);
      setClaims(null);
      setLoading(false);
      return;
    }

    // 3. Real Firebase Auth Listener with error-handling callback to prevent unhandled rejections
    try {
      const unsubscribe = onAuthStateChanged(
        auth,
        async (firebaseUser: FirebaseUser | null) => {
          if (firebaseUser) {
            const isVerified = Boolean(firebaseUser.emailVerified);
            let hasAdminClaim = isVerified && isSuperAdminEmail(firebaseUser.email);
            let userClaims: Record<string, any> = {};

            try {
              // The ID token is the authority for server-issued admin custom claims.
              const tokenResult = await firebaseUser.getIdTokenResult(false);
              userClaims = tokenResult.claims || {};
              setClaims(userClaims);

              if (isVerified && (userClaims.role === 'admin' || userClaims.admin === true)) {
                hasAdminClaim = true;
              }
            } catch (claimsErr: any) {
              console.warn('Could not read Firebase admin claims:', claimsErr?.message || claimsErr);
            }

            // Existing admin documents are provisioned by trusted server/admin tooling only.
            if (isVerified && !hasAdminClaim && db) {
              try {
                const adminDoc = await getDoc(doc(db, COLLECTIONS.ADMINS, firebaseUser.uid));
                if (adminDoc.exists()) {
                  hasAdminClaim = true;
                }
              } catch (err) {
                console.warn('Could not verify admin registry entry:', err);
              }
            }

            const isMaster = hasAdminClaim && isMasterAdminEmail(firebaseUser.email);
            setIsAdmin(hasAdminClaim);
            setIsMasterAdmin(isMaster);
            setUser({
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName || (hasAdminClaim ? 'مسؤول النظام' : 'مستخدم'),
              role: hasAdminClaim ? 'admin' : 'user',
              isAdmin: hasAdminClaim,
              isMasterAdmin: isMaster,
              emailVerified: isVerified,
            });
          } else {
            setUser(null);
            setIsAdmin(false);
            setIsMasterAdmin(false);
            setClaims(null);
          }
          setLoading(false);
        },
        (error) => {
          console.warn('Firebase Auth State listener error:', error);
          setLoading(false);
        }
      );

      // Handle email verification action links (?mode=verifyEmail&oobCode=...)
      if (typeof window !== 'undefined') {
        const urlParams = new URLSearchParams(window.location.search);
        const mode = urlParams.get('mode');
        const oobCode = urlParams.get('oobCode');

        if (mode === 'verifyEmail' && oobCode) {
          AdminService.verifyEmailWithActionCode(oobCode)
            .then(() => {
              window.history.replaceState({}, document.title, window.location.pathname);
              if (auth?.currentUser) {
                reload(auth.currentUser).catch(() => {});
              }
              setUser((prev) => (prev ? { ...prev, emailVerified: true } : null));
            })
            .catch((err) => {
              console.warn('Action code handling error:', err);
            });
        }
      }

      return () => unsubscribe();
    } catch (err) {
      console.warn('Error subscribing to Firebase Auth:', err);
      setLoading(false);
    }
  }, []);

  const login = async (email: string, pass: string) => {
    if (!auth || !isFirebaseConfigured) {
      throw new Error('تعذر تسجيل الدخول: إعدادات Firebase Authentication غير مكتملة. لا يوجد دخول تجريبي في بيئة الإنتاج.');
    }

    const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
    if (!cred.user.emailVerified) {
      await sendEmailVerification(cred.user).catch(() => {});
      throw new Error('يجب تأكيد البريد الإلكتروني أولاً. أرسلنا رابط تأكيد جديد إذا كان ذلك متاحاً.');
    }

    let userClaims: Record<string, any> = {};
    let hasAdminClaim = isSuperAdminEmail(cred.user.email);

    try {
      const tokenResult = await cred.user.getIdTokenResult(true);
      userClaims = tokenResult.claims || {};
      setClaims(userClaims);
      if (userClaims.role === 'admin' || userClaims.admin === true) {
        hasAdminClaim = true;
      }
    } catch (claimErr) {
      console.warn('Could not refresh token claims on login:', claimErr);
    }

    if (!hasAdminClaim && db) {
      try {
        const adminDoc = await getDoc(doc(db, COLLECTIONS.ADMINS, cred.user.uid));
        hasAdminClaim = adminDoc.exists();
      } catch (err) {
        console.warn('Admin registry check error:', err);
      }
    }

    if (!hasAdminClaim) {
      setIsAdmin(false);
      setIsMasterAdmin(false);
      await signOut(auth).catch(() => {});
      throw new Error(
        'هذا الحساب لا يملك صلاحية مدير النظام. يجب منحه صلاحية عبر Firebase Admin SDK أو تسجيله مسبقاً في قائمة المسؤولين.'
      );
    }

    const isMaster = isMasterAdminEmail(cred.user.email);
    setIsAdmin(true);
    setIsMasterAdmin(isMaster);
    setUser({
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName || 'مسؤول النظام',
      role: 'admin',
      isAdmin: true,
      isMasterAdmin: isMaster,
      emailVerified: true,
    });
  };

  const loginWithGoogle = async () => {
    if (!auth || !isFirebaseConfigured) {
      throw new Error('Firebase Auth غير مهيأ حالياً.');
    }

    const cred = await signInWithPopup(auth, googleProvider);
    if (!cred.user.emailVerified) {
      await signOut(auth).catch(() => {});
      throw new Error('يجب استخدام حساب Google موثّق لتسجيل الدخول إلى لوحة الإدارة.');
    }

    let hasAdminClaim = isSuperAdminEmail(cred.user.email);
    let userClaims: Record<string, any> = {};

    try {
      const tokenResult = await cred.user.getIdTokenResult(true);
      userClaims = tokenResult.claims || {};
      setClaims(userClaims);
      if (userClaims.role === 'admin' || userClaims.admin === true) {
        hasAdminClaim = true;
      }
    } catch (claimErr) {
      console.warn('Could not refresh token claims on Google login:', claimErr);
    }

    if (!hasAdminClaim && db) {
      try {
        const adminDoc = await getDoc(doc(db, COLLECTIONS.ADMINS, cred.user.uid));
        hasAdminClaim = adminDoc.exists();
      } catch (err) {
        console.warn('Admin registry check error:', err);
      }
    }

    if (!hasAdminClaim) {
      setIsAdmin(false);
      setIsMasterAdmin(false);
      await signOut(auth).catch(() => {});
      throw new Error('حساب Google هذا غير مسجل كمسؤول في لوحة الإدارة.');
    }

    // Cache the Google OAuth token only after the account passes the admin gate.
    const credential = GoogleAuthProvider.credentialFromResult(cred);
    if (credential?.accessToken) {
      setCachedGoogleToken(credential.accessToken);
    }

    const isMaster = isMasterAdminEmail(cred.user.email);
    setIsAdmin(true);
    setIsMasterAdmin(isMaster);
    setUser({
      uid: cred.user.uid,
      email: cred.user.email,
      displayName: cred.user.displayName || 'مسؤول النظام',
      role: 'admin',
      isAdmin: true,
      isMasterAdmin: isMaster,
      emailVerified: true,
    });
  };

  const logout = async () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('elbatal_demo_admin_session');
      window.sessionStorage.removeItem('elbatal_explicit_logout');
    }
    setCachedGoogleToken(null);
    if (auth && isFirebaseConfigured) {
      try {
        await signOut(auth);
      } catch (err) {
        console.warn('Firebase signOut notice:', err);
      }
    }
    setUser(null);
    setIsAdmin(false);
    setIsMasterAdmin(false);
    setClaims(null);
  };

  // Retained for compatibility with older UI bundles, but demo access is permanently disabled.
  const loginAsDemoAdmin = (): never => {
    throw new Error('الدخول التجريبي معطّل. يجب تسجيل الدخول عبر Firebase Authentication بحساب مسؤول موثّق.');
  };

  const updateDisplayName = async (newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('الاسم لا يمكن أن يكون فارغاً');

    // 1. Update local state immediately for responsive UI
    setUser((prev) => (prev ? { ...prev, displayName: trimmed } : null));

    // 2. Update Firebase Auth if user exists
    if (auth?.currentUser) {
      try {
        await updateProfile(auth.currentUser, { displayName: trimmed });
      } catch (e) {
        console.warn('Firebase Auth updateProfile error:', e);
      }
    }

    // Admin registry documents are server-managed; the client updates Firebase Auth profile only.
  };

  const changePassword = async (
    newPassword: string
  ): Promise<{ success: boolean; resetEmailSent?: boolean }> => {
    if (!newPassword || newPassword.length < 6) {
      throw new Error('كلمة المرور يجب ألا تقل عن 6 أحرف أو أرقام');
    }

    if (auth && auth.currentUser) {
      try {
        await updatePassword(auth.currentUser, newPassword);
        return { success: true };
      } catch (err: any) {
        // If Firebase requires recent login, send secure reset email
        if (err.code === 'auth/requires-recent-login') {
          if (auth.currentUser.email) {
            await sendPasswordResetEmail(auth, auth.currentUser.email);
            return { success: true, resetEmailSent: true };
          }
        }
        throw new Error(err.message || 'فشل تحديث كلمة المرور');
      }
    }

    throw new Error('لا توجد جلسة Firebase Authentication نشطة لتغيير كلمة المرور.');
  };

  const resendVerificationEmail = async (): Promise<void> => {
    if (auth?.currentUser) {
      await sendEmailVerification(auth.currentUser);
      return;
    }
    throw new Error('سجّل الدخول بحساب Firebase لإعادة إرسال رابط التحقق.');
  };

  const checkVerificationStatus = async (): Promise<boolean> => {
    if (auth?.currentUser) {
      await reload(auth.currentUser);
      const verified = Boolean(auth.currentUser.emailVerified);
      if (verified) {
        setUser((prev) => (prev ? { ...prev, emailVerified: true } : null));
      }
      return verified;
    }
    return Boolean(user?.emailVerified);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin,
        isMasterAdmin,
        claims,
        login,
        loginWithGoogle,
        logout,
        loginAsDemoAdmin,
        updateDisplayName,
        changePassword,
        resendVerificationEmail,
        checkVerificationStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
