import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import TopNav from '@/components/TopNav'
import './globals.css'

// Apply Geist's generated CSS variable to <html> so the font reaches every page.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: 'Smart Maritime Boundary Monitoring System',
  description: 'Created with v0',
  generator: 'v0.app',
  icons: {
    icon: '/image.png',
    apple: '/image.png',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <head>
        {/* Runtime env injected by the container's startup script */}
        <script src="/env.js" defer />
      </head>
      <body className="font-sans antialiased">
        <TopNav />
        {children}
      </body>
    </html>
  )
}
