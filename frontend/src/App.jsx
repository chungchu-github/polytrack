import { Routes, Route, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import Layout from "./components/Layout.jsx";
import LoginModal from "./components/LoginModal.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Wallets from "./pages/Wallets.jsx";
import WalletDetail from "./pages/WalletDetail.jsx";
import Markets from "./pages/Markets.jsx";
import Trades from "./pages/Trades.jsx";
import Risk from "./pages/Risk.jsx";
import Backtest from "./pages/Backtest.jsx";
import Settings from "./pages/Settings.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import NotFound from "./pages/NotFound.jsx";

export default function App() {
  // /register is the only route that should render WITHOUT triggering the
  // login modal — invitees haven't signed in yet.
  const onRegister = useLocation().pathname.startsWith("/register");

  return (
    <>
      {!onRegister && <LoginModal />}
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          // Match the surface palette so toasts feel native instead of stock-white.
          style: {
            background: "rgb(15 23 42)",     // surface-900
            border: "1px solid rgb(51 65 85)", // surface-700
            color: "rgb(226 232 240)",       // surface-200
          },
          className: "font-sans",
        }}
        closeButton
        duration={4000}
      />
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="wallets" element={<Wallets />} />
          <Route path="wallets/:addr" element={<WalletDetail />} />
          <Route path="markets" element={<Markets />} />
          <Route path="trades" element={<Trades />} />
          <Route path="risk" element={<Risk />} />
          <Route path="backtest" element={<Backtest />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
