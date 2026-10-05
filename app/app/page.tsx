import Workspace from '@/components/Workspace';

// /app is protected by proxy.ts (matcher '/app/:path*'), so a request that
// reaches this page has a session; the 401 path on both API endpoints is the
// second line of defence when the session expires mid-session.
export default function AppPage() {
  return <Workspace />;
}
