import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { DashboardLayout } from './layouts/DashboardLayout';

// Load route components on demand so the initial bundle does not include every page.
const LoginPage = React.lazy(() => import('./pages/Login').then((module) => ({ default: module.LoginPage })));
const RegisterAdminPage = React.lazy(() => import('./pages/RegisterAdmin').then((module) => ({ default: module.RegisterAdminPage })));
const LandingPage = React.lazy(() => import('./pages/Landing').then((module) => ({ default: module.LandingPage })));
const PrivacyPolicyPage = React.lazy(() => import('./pages/PrivacyPolicy').then((module) => ({ default: module.PrivacyPolicyPage })));
const TermsOfServicePage = React.lazy(() => import('./pages/TermsOfService').then((module) => ({ default: module.TermsOfServicePage })));
const DashboardPage = React.lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.DashboardPage })));
const RestaurantsPage = React.lazy(() => import('./pages/Restaurants').then((module) => ({ default: module.RestaurantsPage })));
const CaptainsPage = React.lazy(() => import('./pages/Captains').then((module) => ({ default: module.CaptainsPage })));
const OrdersPage = React.lazy(() => import('./pages/Orders').then((module) => ({ default: module.OrdersPage })));
const SubscriptionsPage = React.lazy(() => import('./pages/Subscriptions').then((module) => ({ default: module.SubscriptionsPage })));
const SubscriptionRequestsPage = React.lazy(() => import('./pages/SubscriptionRequests').then((module) => ({ default: module.SubscriptionRequestsPage })));
const PackagesPage = React.lazy(() => import('./pages/Packages').then((module) => ({ default: module.PackagesPage })));
const PaymentsPage = React.lazy(() => import('./pages/Payments').then((module) => ({ default: module.PaymentsPage })));
const SettingsPage = React.lazy(() => import('./pages/Settings').then((module) => ({ default: module.SettingsPage })));
const SendOrderPage = React.lazy(() => import('./pages/SendOrder').then((module) => ({ default: module.SendOrderPage })));
const AdminsPage = React.lazy(() => import('./pages/Admins').then((module) => ({ default: module.AdminsPage })));
const GoogleSheetsPage = React.lazy(() => import('./pages/GoogleSheets').then((module) => ({ default: module.GoogleSheetsPage })));
const LiveMapPage = React.lazy(() => import('./pages/LiveMap').then((module) => ({ default: module.LiveMapPage })));
const CaptainShiftsPage = React.lazy(() => import('./pages/CaptainShifts').then((module) => ({ default: module.CaptainShiftsPage })));
const CaptainRegistrationsPage = React.lazy(() => import('./pages/CaptainRegistrations').then((module) => ({ default: module.CaptainRegistrationsPage })));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <NotificationProvider>
            <React.Suspense
              fallback={
                <div
                  role="status"
                  aria-live="polite"
                  className="flex min-h-screen items-center justify-center bg-[#0b0d11] text-zinc-100"
                >
                  جارٍ تحميل الصفحة...
                </div>
              }
            >
              <Routes>
                {/* Public Brand & Verification Routes (No Authentication Required) */}
                <Route path="/" element={<Navigate to="/home" replace />} />
                <Route path="/home" element={<LandingPage />} />
                <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
                <Route path="/terms-of-service" element={<TermsOfServicePage />} />

                {/* Public authentication routes */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register-admin" element={<RegisterAdminPage />} />

                {/* Protected Admin Routes */}
                <Route element={<ProtectedRoute />}>
                  <Route element={<DashboardLayout />}>
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/live-map" element={<LiveMapPage />} />
                    <Route path="/send-order" element={<SendOrderPage />} />
                    <Route path="/shifts" element={<CaptainShiftsPage />} />
                    <Route path="/merchants" element={<RestaurantsPage />} />
                    <Route path="/merchants/:restaurantId/orders" element={<OrdersPage />} />
                    <Route path="/restaurants" element={<Navigate to="/merchants" replace />} />
                    <Route path="/restaurants/:restaurantId/orders" element={<OrdersPage />} />
                    <Route path="/captains" element={<CaptainsPage />} />
                    <Route path="/captain-registrations" element={<CaptainRegistrationsPage />} />
                    <Route path="/orders" element={<OrdersPage />} />
                    <Route path="/packages" element={<PackagesPage />} />
                    <Route path="/subscription-requests" element={<SubscriptionRequestsPage />} />
                    <Route path="/subscriptions" element={<SubscriptionsPage />} />
                    <Route path="/payments" element={<PaymentsPage />} />
                    <Route path="/sheets" element={<GoogleSheetsPage />} />
                    <Route path="/admins" element={<AdminsPage />} />
                    <Route path="/admins/new" element={<RegisterAdminPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Route>
                </Route>

                {/* Fallback redirects to public landing page */}
                <Route path="*" element={<Navigate to="/home" replace />} />
              </Routes>
            </React.Suspense>
          </NotificationProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
