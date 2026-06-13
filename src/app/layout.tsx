import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Twitter network',
  description:
    "Pull any Twitter account's followers and rank each one against custom criteria with Claude.",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
