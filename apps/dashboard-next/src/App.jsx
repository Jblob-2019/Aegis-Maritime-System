import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import TopNav from '@/components/TopNav';
import RootPage from './page';
import DashboardPage from './dashboard/page';
import LoginPage from './login/page';
import LogsPage from './logs/page';

export default function App() {
  return (
    <BrowserRouter>
      <TopNav />
      <Suspense fallback={<div>Loading...</div>}>
        <Routes>
          <Route path="/" element={<RootPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/logs" element={<LogsPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
