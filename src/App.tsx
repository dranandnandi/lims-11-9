// src/App.tsx
import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { QZTrayProvider } from './contexts/QZTrayContext';
import { SampleTypeColorsProvider } from './contexts/SampleTypeColorsContext';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import Login from './components/Auth/Login';
import Signup from './components/Auth/Signup';
import ForgotPassword from './components/Auth/ForgotPassword';
import ResetPassword from './components/Auth/ResetPassword';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Patients from './pages/Patients';
import Tests from './pages/Tests';
import Orders from './pages/Orders';
import Reports from './pages/Reports';
import PeripheralSmearDemo from './components/Workflows/PeripheralSmearDemo';
import Billing from './pages/Billing';
import CashReconciliation from './pages/CashReconciliation';
import UserManagement from './pages/UserManagement';
import Settings from './pages/Settings';
import ResultVerificationConsole from './pages/ResultVerificationConsole';
import { WorkflowManagement } from './pages/WorkflowManagement';
// DEPRECATED: Consolidated into WorkflowManagement with UnifiedWorkflowRunner
// import WorkflowDemo from './pages/WorkflowDemo';
import OrderDetail from './pages/OrderDetail';
import WhatsApp from './pages/WhatsApp';
import WhatsAppUserSyncManager from './components/WhatsApp/WhatsAppUserSyncManager';
import WhatsAppTemplates from './pages/WhatsAppTemplates';
import { useWhatsAppAutoSync } from './hooks/useWhatsAppAutoSync';
import { warmupPuppeteer } from './utils/pdfService';
import { initializeNativePlatform, cleanupNativePlatform } from './utils/nativeInit';
import "./styles/print.css";

// ⬇️ New modern dashboard page
import Dashboard2 from './pages/Dashboard2';
import VisualFormBuilder from './pages/VisualFormBuilder';

// ⬇️ New AI-integrated results page
import Result2 from './pages/result2';

// ⬇️ Master Data Components
import DoctorMaster from './components/Masters/DoctorMaster';
import LocationMaster from './components/Masters/LocationMaster';
import AccountMaster from './components/Masters/AccountMaster';
import TemplateStudioCKE from './pages/TemplateStudioCKE';
import { BrandingSettings } from './pages/BrandingSettings';
import WorkflowConfiguratorPage from './pages/WorkflowConfiguratorPage';
import WorkflowEvaluatorPage from './pages/WorkflowEvaluatorPage';
// DEPRECATED: Consolidated into WorkflowConfiguratorPage
// import WorkflowExplainerDemo from './pages/WorkflowExplainerDemo';
// DEPRECATED: Test page with hardcoded data - no longer needed
// import WorkflowExplainerTestPage from './pages/WorkflowExplainerTestPage';
import OptimizationDemo from './pages/OptimizationDemo';
import OutsourcedReportsConsole from './pages/OutsourcedReportsConsole';
import OutsourcedReportsConsoleEnhanced from './pages/OutsourcedReportsConsoleEnhanced';
import OutsourcedTestsQueue from './pages/OutsourcedTestsQueue';
import OutsourcedLabsSettings from './pages/OutsourcedLabsSettings';
import IntraLabTransitQueue from './pages/IntraLabTransitQueue';
import ManageReportSections from './pages/settings/ManageReportSections';
import LabOnboarding from './pages/LabOnboarding';
import Subscription from './pages/Subscription';
import VerificationPage from './pages/VerificationPage';
import FinancialReports from './pages/FinancialReports';
import Analytics from './pages/Analytics';
import QualityControl from './pages/QualityControl';
import Inventory from './pages/Inventory';
import CorporateBulkRegistration from './pages/CorporateBulkRegistration';
import Accession from './pages/Accession';
import PhleboCollections from './pages/PhleboCollections';

// ⬇️ B2B Portal
import B2BLogin from './pages/B2BLogin';
import B2BPortal from './pages/B2BPortal';
import B2BPaymentSuccess from './pages/B2BPaymentSuccess';
import B2BPaymentFailed from './pages/B2BPaymentFailed';
import ProtectedB2BRoute from './components/Auth/ProtectedB2BRoute';

// ⬇️ Patient Portal
import PatientLogin from './pages/PatientLogin';
import PatientPortal from './pages/PatientPortal';
import ProtectedPatientRoute from './components/Auth/ProtectedPatientRoute';

// ⬇️ Doctor Sharing Portal (Admin Only)
import DoctorSharingLogin from './pages/DoctorSharingLogin';
import DoctorSharingLayout from './pages/DoctorSharingLayout';
import DoctorSharingDashboard from './pages/DoctorSharingDashboard';
import DoctorSharingSettings from './pages/DoctorSharingSettings';
import DoctorCommissionReport from './pages/DoctorCommissionReport';

// WhatsApp Hybrid System Components
import { FailedNotificationToast } from './components/WhatsApp/FailedNotificationToast';

// Build target: 'lims' (default, full app) | 'patient' (patient portal only) | 'phlebo' (phlebo collections only).
// Set via VITE_APP_TARGET at build time; unset = full LIMS, so web builds are unaffected.
const APP_TARGET = (import.meta.env.VITE_APP_TARGET as string | undefined) || 'lims';

const AppRoutes: React.FC = () => {
  const { user, loading } = useAuth();

  // Initialize WhatsApp auto-sync when user is authenticated
  useWhatsAppAutoSync();

  // Per-app browser/tab title (index.html is shared by all three builds)
  useEffect(() => {
    if (APP_TARGET === 'patient') document.title = 'AnPro Patient';
    else if (APP_TARGET === 'phlebo') document.title = 'AnPro Phlebo';
  }, []);

  // Initialize native platform features
  useEffect(() => {
    initializeNativePlatform().catch(err => {
      console.warn('Native platform initialization failed:', err);
    });

    return () => {
      cleanupNativePlatform();
    };
  }, []);

  // Warm up Puppeteer instance for faster PDF generation
  useEffect(() => {
    // Warmup after a short delay to not block initial render
    const timer = setTimeout(() => {
      warmupPuppeteer().catch(err => {
        console.warn('Puppeteer warmup failed:', err);
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  // Show loading state while auth is initializing
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  // Patient app: only the patient portal is reachable
  if (APP_TARGET === 'patient') {
    return (
      <Routes>
        <Route path="/patient/login" element={<PatientLogin />} />
        <Route
          path="/patient/portal"
          element={
            <ProtectedPatientRoute>
              <PatientPortal />
            </ProtectedPatientRoute>
          }
        />
        <Route path="/verify" element={<VerificationPage />} />
        <Route path="*" element={<Navigate to="/patient/login" replace />} />
      </Routes>
    );
  }

  // Phlebo app: staff login, then straight to collections (no staff layout/sidebar)
  if (APP_TARGET === 'phlebo') {
    return (
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/phlebo" replace /> : <Login />}
        />
        <Route
          path="/forgot-password"
          element={user ? <Navigate to="/phlebo" replace /> : <ForgotPassword />}
        />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="*"
          element={
            <ProtectedRoute>
              <PhleboCollections />
            </ProtectedRoute>
          }
        />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Public routes */}
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/signup"
        element={user ? <Navigate to="/" replace /> : <Signup />}
      />
      <Route
        path="/forgot-password"
        element={user ? <Navigate to="/" replace /> : <ForgotPassword />}
      />
      <Route
        path="/reset-password"
        element={<ResetPassword />}
      />
      <Route
        path="/onboard"
        element={<LabOnboarding />}
      />

      {/* Public Verification Route */}
      <Route
        path="/verify"
        element={<VerificationPage />}
      />

      {/* B2B Portal routes */}
      <Route
        path="/b2b"
        element={<B2BLogin />}
      />
      <Route
        path="/b2b/portal"
        element={
          <ProtectedB2BRoute>
            <B2BPortal />
          </ProtectedB2BRoute>
        }
      />
      <Route path="/b2b/payment/success" element={<B2BPaymentSuccess />} />
      <Route path="/b2b/payment/failed" element={<B2BPaymentFailed />} />
      <Route path="/b2b/payment/cancelled" element={<B2BPaymentFailed />} />

      {/* Patient Portal routes */}
      <Route
        path="/patient/login"
        element={<PatientLogin />}
      />
      <Route
        path="/patient/portal"
        element={
          <ProtectedPatientRoute>
            <PatientPortal />
          </ProtectedPatientRoute>
        }
      />

      {/* Doctor Sharing Portal routes (Admin Only) */}
      <Route
        path="/doctor-sharing"
        element={<DoctorSharingLogin />}
      />
      <Route
        path="/doctor-sharing/login"
        element={<DoctorSharingLogin />}
      />
      <Route
        path="/doctor-sharing/*"
        element={
          <DoctorSharingLayout>
            <Routes>
              <Route path="dashboard" element={<DoctorSharingDashboard />} />
              <Route path="settings" element={<DoctorSharingSettings />} />
              <Route path="commission" element={<DoctorCommissionReport />} />
              <Route path="*" element={<Navigate to="/doctor-sharing/dashboard" replace />} />
            </Routes>
          </DoctorSharingLayout>
        }
      />


      {/* Protected routes */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                {/* New modern dashboard route */}
                <Route path="/dashboard2" element={<Dashboard2 />} />

                <Route path="/patients" element={<Patients />} />
                <Route path="/phlebo" element={<PhleboCollections />} />
                <Route path="/tests" element={<Tests />} />
                <Route path="/orders" element={<Orders />} />
                {/* <Route path="/results" element={<Results />} /> Hidden - use Results Entry 2 */}
                <Route path="/results2" element={<Result2 />} />
                <Route path="/results-verification" element={<ResultVerificationConsole />} />
                <Route path="/reports" element={<Reports />} />
                {/* Dev workflow demo route (no DB changes) */}
                <Route path="/workflow-demo/peripheral-smear" element={<PeripheralSmearDemo />} />
                <Route path="/billing" element={<Billing />} />
                <Route path="/subscription" element={<Subscription />} />
                <Route path="/cash-reconciliation" element={<CashReconciliation />} />
                <Route path="/financial-reports" element={<FinancialReports />} />
                <Route path="/analytics" element={<Analytics />} />
                {/* <Route path="/ai-tools" element={<AITools />} /> Hidden */}
                {/* <Route path="/ai-prompts" element={<AIPromptManager />} /> Hidden */}
                <Route path="/settings" element={<Settings />} />
                <Route path="/settings/branding" element={<BrandingSettings />} />
                <Route path="/user-management" element={<UserManagement />} />
                <Route path="/verification" element={<ResultVerificationConsole />} />
                <Route path="/workflows" element={<WorkflowManagement />} />
                <Route path="/quality-control" element={<QualityControl />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/accession" element={<Accession />} />
                {/* DEPRECATED: Use /workflows instead */}
                {/* <Route path="/workflow-demo" element={<WorkflowDemo />} /> */}
                <Route path="/workflow-configurator" element={<WorkflowConfiguratorPage />} />
                <Route path="/workflow-evaluator/:protocolId" element={<WorkflowEvaluatorPage />} />
                {/* DEPRECATED: Use /workflow-configurator instead */}
                {/* <Route path="/workflow-explainer-demo" element={<WorkflowExplainerDemo />} /> */}
                <Route path="/optimization-demo" element={<OptimizationDemo />} />
                <Route path="/visual-form-builder" element={<VisualFormBuilder />} />
                <Route path="/orders/:id" element={<OrderDetail />} />
                {/* <Route path="/template-studio" element={<TemplateStudio />} /> Hidden */}
                <Route path="/template-studio-cke" element={<TemplateStudioCKE />} />
                {/* WhatsApp Integration */}
                <Route path="/whatsapp" element={<WhatsApp />} />
                <Route path="/whatsapp/sync" element={<WhatsAppUserSyncManager />} />
                <Route path="/whatsapp/templates" element={<WhatsAppTemplates />} />
                {/* Master Data Routes */}
                <Route path="/outsourced-reports" element={<OutsourcedReportsConsoleEnhanced />} />
                <Route path="/outsourced-reports-legacy" element={<OutsourcedReportsConsole />} />
                <Route path="/outsourced-queue" element={<OutsourcedTestsQueue />} />
                <Route path="/sample-transit" element={<IntraLabTransitQueue />} />
                <Route path="/settings/outsourced-labs" element={<OutsourcedLabsSettings />} />
                <Route path="/settings/report-sections" element={<ManageReportSections />} />
                <Route path="/masters/doctors" element={<DoctorMaster />} />
                <Route path="/masters/accounts" element={<AccountMaster />} />
                <Route path="/masters/locations" element={<LocationMaster />} />
                <Route path="/corporate-bulk" element={<CorporateBulkRegistration />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <SampleTypeColorsProvider>
          <QZTrayProvider>
            <Router>
              <AppRoutes />
              {/* Global WhatsApp Failed Notification Toast - shows realtime alerts */}
              <FailedNotificationToast />
            </Router>
          </QZTrayProvider>
        </SampleTypeColorsProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
