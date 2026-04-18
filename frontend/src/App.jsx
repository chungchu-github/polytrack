import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Wallets from "./pages/Wallets.jsx";
import WalletDetail from "./pages/WalletDetail.jsx";
import Markets from "./pages/Markets.jsx";
import Trades from "./pages/Trades.jsx";
import Risk from "./pages/Risk.jsx";
import Backtest from "./pages/Backtest.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="wallets" element={<Wallets />} />
        <Route path="wallets/:addr" element={<WalletDetail />} />
        <Route path="markets" element={<Markets />} />
        <Route path="trades" element={<Trades />} />
        <Route path="risk" element={<Risk />} />
        <Route path="backtest" element={<Backtest />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
