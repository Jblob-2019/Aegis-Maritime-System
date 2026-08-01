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

    // --- HACKATHON SHORTCUT FOR DEMO ---
    // If you want to bypass the database for the demo video, use this block:
    if (username === 'admin' && password === 'admin123') {
      localStorage.setItem('role', 'admin');
      navigate('/dashboard');
      return;
    }

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
        navigate('/dashboard');
      } else if (role === 'fisherman') {
        localStorage.setItem('boatId', boatId);
        navigate('/my-boat');
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
      className="min-h-screen bg-gray-900 flex items-center justify-center p-4"
      style={{
        backgroundImage:
          'radial-gradient(circle at center, #1f2937 0%, #111827 100%)',
      }}
    >
      {/* Glassmorphism Card */}
      <div className="max-w-md w-full bg-white/10 backdrop-blur-md border border-white/20 rounded-xl shadow-2xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-wider font-mono">
            AEGIS SYSTEM
          </h1>
          <p className="text-cyan-400 text-sm mt-2 font-mono">
            MARITIME BOUNDARY DEFENSE
          </p>
        </div>

        {error && (
          <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded mb-4 text-center font-mono text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-gray-300 text-sm font-bold mb-2 font-mono">
              OPERATOR ID
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-gray-800/50 border border-gray-600 text-white rounded px-4 py-3 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
              placeholder="Enter ID..."
              required
            />
          </div>

          <div>
            <label className="block text-gray-300 text-sm font-bold mb-2 font-mono">
              PASSCODE
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-800/50 border border-gray-600 text-white rounded px-4 py-3 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-3 px-4 rounded transition-colors duration-200 font-mono tracking-widest mt-4"
          >
            INITIALIZE UPLINK
          </button>
        </form>
      </div>
    </div>
  );
}
