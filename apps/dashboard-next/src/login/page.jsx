'use client'; // CRITICAL: This tells Next.js this file uses React state and browser hooks

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios, { AxiosError } from 'axios';
import { getRuntimeEnv } from '@/lib/env';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  // Redirect to dashboard if already logged in.
  useEffect(() => {
    const token = localStorage.getItem('token');
    const role = localStorage.getItem('role');
    if (token && role) {
      navigate('/dashboard');
    }
  }, [navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    // --- PRODUCTION AXIOS LOGIC ---
    try {
      const { NEXT_PUBLIC_BACKEND_URL } = getRuntimeEnv();
      const response = await axios.post(
        `${NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000'}/api/auth/login`,
        {
          username: username,
          password: password,
        }
      );

      const { role, token, boatId } = response.data;

      localStorage.setItem('token', token);
      localStorage.setItem('role', role);

      if (role === 'admin') {
        window.location.href = '/dashboard';
      } else if (role === 'fisherman') {
        localStorage.setItem('boatId', boatId);
        window.location.href = '/my-boat';
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        setError(
          err.response.data?.message || 'Invalid credentials. Access Denied.'
        );
      } else {
        setError('Cannot connect to the server. Uplink failed.');
      }
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 bg-[#020817] relative overflow-hidden"
    >
      {/* Background styling elements to match dashboard */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 50% 30%, rgba(0,218,243,0.05) 0%, transparent 60%)' }} />
      <div className="absolute w-[1px] h-full bg-[rgba(59,73,76,0.2)] left-1/4 pointer-events-none" />
      <div className="absolute w-[1px] h-full bg-[rgba(59,73,76,0.2)] right-1/4 pointer-events-none" />
      <div className="absolute h-[1px] w-full bg-[rgba(59,73,76,0.2)] top-1/4 pointer-events-none" />
      <div className="absolute h-[1px] w-full bg-[rgba(59,73,76,0.2)] bottom-1/4 pointer-events-none" />

      {/* Glassmorphism Card */}
      <div className="max-w-md w-full hud-panel-intense p-10 relative z-10 animate-fade-in">
        <div className="text-center mb-10">
          <div className="flex justify-center items-center gap-3 mb-4">
            <span className="w-2.5 h-2.5 bg-[#00ff95] rounded-full animate-pulse shadow-[0_0_12px_rgba(0,255,149,0.8)]" />
            <h1 className="text-[26px] font-bold text-[#c3f5ff] tracking-[0.1em]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              AEGIS COMMAND
            </h1>
          </div>
          <p className="text-[#8a96ad] text-[11px] font-bold tracking-widest border-b border-[rgba(59,73,76,0.3)] pb-4">
            MARITIME BOUNDARY DEFENSE
          </p>
        </div>

        {error && (
          <div className="bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.4)] text-[#ef4444] p-3 rounded-lg mb-6 text-center text-[11px] font-bold tracking-wider">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-[#8a96ad] text-[10px] font-bold mb-2 tracking-widest">
              OPERATOR ID
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(59,73,76,0.5)] text-[#dce4e5] text-sm rounded-lg px-4 py-3 focus:outline-none focus:border-[#00daf3] focus:shadow-[0_0_15px_rgba(0,218,243,0.2)] transition-all font-mono"
              placeholder="Enter ID..."
              required
            />
          </div>

          <div>
            <label className="block text-[#8a96ad] text-[10px] font-bold mb-2 tracking-widest">
              PASSCODE
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(59,73,76,0.5)] text-[#dce4e5] text-sm rounded-lg px-4 py-3 focus:outline-none focus:border-[#00daf3] focus:shadow-[0_0_15px_rgba(0,218,243,0.2)] transition-all font-mono"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="w-full bg-[rgba(0,218,243,0.1)] hover:bg-[rgba(0,218,243,0.2)] border border-[#00daf3] text-[#00daf3] font-bold py-3.5 px-4 rounded-lg transition-all duration-200 tracking-widest text-[12px] mt-8 hover:shadow-[0_0_20px_rgba(0,218,243,0.3)]"
          >
            INITIALIZE UPLINK
          </button>
        </form>
      </div>
    </div>
  );
}
