'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function RootPage() {
  const router = useRouter()

  useEffect(() => {
    // Always redirect to login on page refresh/load for security
    localStorage.removeItem('role')
    localStorage.removeItem('token')
    router.push('/login')
  }, [router])

  return (
    <>
      <noscript>
        <div style={{ padding: '1rem', fontFamily: 'sans-serif' }}>
          JavaScript is disabled. Please <a href="/login">log in</a> to continue.
        </div>
      </noscript>
    </>
  )
}
