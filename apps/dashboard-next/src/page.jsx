'use client';

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function RootPage() {
  const navigate = useNavigate();

  useEffect(() => {
    // If the user already has a valid token, send them straight to the dashboard.
    // Only purge stale auth state (no token / no role) before redirecting to /login.
    const token = localStorage.getItem('token');
    const role = localStorage.getItem('role');

    if (token && role) {
      navigate('/dashboard');
      return;
    }

    // No valid session — clear any half-set values and go to login.
    localStorage.removeItem('role');
    localStorage.removeItem('token');
    navigate('/login');
  }, [navigate]);

  return (
    <>
      <noscript>
        <div style={{ padding: '1rem', fontFamily: 'sans-serif' }}>
          JavaScript is disabled. Please <a href="/login">log in</a> to
          continue.
        </div>
      </noscript>
    </>
  );
}
