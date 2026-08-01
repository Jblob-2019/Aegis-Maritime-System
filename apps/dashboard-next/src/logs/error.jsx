'use client';

import { useEffect } from 'react';

export default function LogsError({ error, reset }) {
  useEffect(() => {
    console.error('Logs Render Error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#020817] text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-yellow-500/40 bg-[#0d2137]/90 p-6 backdrop-blur-md shadow-2xl text-center">
        <div className="w-12 h-12 rounded-full bg-yellow-500/20 text-yellow-400 flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-yellow-200 mb-2">
          Logs Render Error
        </h2>
        <p className="text-sm text-gray-300 mb-6">
          Unable to display vessel log history. Please try reloading the view.
        </p>
        <button
          onClick={() => reset()}
          className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-sm transition-colors"
        >
          Reload Logs
        </button>
      </div>
    </div>
  );
}
