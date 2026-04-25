import { useLocation, Link } from "react-router-dom";

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col items-center justify-center text-center min-h-[60vh] px-4">
      <p className="font-display text-5xl font-bold text-primary">404</p>
      <h1 className="mt-4 text-lg font-semibold text-surface-100">
        Page not found
      </h1>
      <p className="mt-2 text-sm text-surface-500 max-w-md">
        Nothing lives at <code className="text-surface-400">{pathname}</code>.
        It may have been moved, or you may have followed an old link.
      </p>
      <div className="mt-6 flex items-center gap-3 text-sm">
        <Link
          to="/"
          className="px-3 py-1.5 rounded-md bg-primary text-surface-950 font-semibold hover:bg-primary/90 transition-colors"
        >
          ← Back to dashboard
        </Link>
        <Link
          to="/wallets"
          className="text-surface-400 underline underline-offset-2 hover:text-surface-200"
        >
          Or jump to Wallets
        </Link>
      </div>
    </div>
  );
}
