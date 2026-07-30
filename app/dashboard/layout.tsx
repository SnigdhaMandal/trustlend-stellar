import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary"
import { RpcHealthProvider } from "@/components/RpcHealthProvider"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <GlobalErrorBoundary>
      <RpcHealthProvider>{children}</RpcHealthProvider>
    </GlobalErrorBoundary>
  )
}
