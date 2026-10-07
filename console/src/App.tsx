import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { AppLayout, PublicLayout } from "./components/Layout";
import type { ConsoleConfig } from "./config";
import { AccountPage } from "./pages/AccountPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { NewProgramPage } from "./pages/NewProgramPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProgramEditorPage } from "./pages/ProgramEditorPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public pages linked from viewer emails — no sign-in. */}
      <Route element={<PublicLayout />}>
        <Route path="/account/verify-email" element={<VerifyEmailPage />} />
        <Route path="/account/reset-password" element={<ResetPasswordPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/programs/new" element={<NewProgramPage />} />
          <Route path="/programs/:id" element={<ProgramEditorPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/uploads" element={<Navigate to="/programs/new" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

export function App({ config }: { config: ConsoleConfig }) {
  return (
    <AuthProvider config={config}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
