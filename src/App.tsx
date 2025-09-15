// src/App.tsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import Login from './components/Auth/Login';
import Signup from './components/Auth/Signup';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard';
import Patients from './pages/Patients';
import Tests from './pages/Tests_Working';
import Orders from './pages/Orders';
import Results from './pages/Results';
import Reports from './pages/Reports';
import PeripheralSmearDemo from './components/Workflows/PeripheralSmearDemo';
import Billing from './pages/Billing';
import CashReconciliation from './pages/CashReconciliation';
import AITools from './pages/AITools';
import Settings from './pages/Settings';
import ResultVerificationConsole from './pages/ResultVerificationConsole';
import { WorkflowManagement } from './pages/WorkflowManagement';
import WorkflowDemo from './pages/WorkflowDemo';
import OrderDetail from './pages/OrderDetail';
import "./styles/print.css";

// ⬇️ New modern dashboard page
import Dashboard2 from './pages/Dashboard2';

const AppRoutes: React.FC = () => {
  const { user, loading } = useAuth();

  // Show loading state while auth is initializing
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
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
                <Route path="/tests" element={<Tests />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/results" element={<ResultVerificationConsole />} />
                <Route path="/results-verification" element={<ResultVerificationConsole />} />
                <Route path="/reports" element={<Reports />} />
                {/* Dev workflow demo route (no DB changes) */}
                <Route path="/workflow-demo/peripheral-smear" element={<PeripheralSmearDemo />} />
                <Route path="/billing" element={<Billing />} />
                <Route path="/cash-reconciliation" element={<CashReconciliation />} />
                <Route path="/ai-tools" element={<AITools />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/verification" element={<ResultVerificationConsole />} />
                <Route path="/workflows" element={<WorkflowManagement />} />
                <Route path="/workflow-demo" element={<WorkflowDemo />} />
                <Route path="/orders/:id" element={<OrderDetail />} />
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
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}

export default App;
