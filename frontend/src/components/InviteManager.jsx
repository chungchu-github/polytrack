import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api/client.js";
import clsx from "clsx";

/**
 * Admin-only invite link manager. Renders nothing for non-admins.
 *
 * Pulls /auth/me to detect role; caller can also pass `role` directly to
 * skip the lookup if it already has it.
 */
export default function InviteManager({ role }) {
  const qc = useQueryClient();
  const [latestUrl, setLatestUrl] = useState(null);

  // Skip the /auth/me round-trip if parent already passed role.
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn:  () => api.me(),
    enabled:  !role,
  });
  const effectiveRole = role || meQuery.data?.user?.role;

  const invitesQuery = useQuery({
    queryKey: ["invitations"],
    queryFn:  api.listInvites,
    enabled:  effectiveRole === "admin",
  });

  const createMut = useMutation({
    mutationFn: api.createInvite,
    onSuccess:  (data) => {
      const fullUrl = window.location.origin + data.url;
      setLatestUrl(fullUrl);
      qc.invalidateQueries({ queryKey: ["invitations"] });
      toast.success("Invite link created", { description: "Send it to your invitee — expires in 7 days." });
    },
    onError: (e) => toast.error(e.message || "Failed to create invite"),
  });

  const revokeMut = useMutation({
    mutationFn: (token) => api.revokeInvite(token),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ["invitations"] });
      toast.success("Invite revoked");
    },
    onError: (e) => toast.error(e.message || "Failed to revoke invite"),
  });

  if (effectiveRole !== "admin") return null;

  const list = invitesQuery.data || [];
  const now  = Date.now();

  return (
    <div className="card">
      <h2 className="card-header">Invite Manager</h2>
      <p className="text-2xs text-surface-500 mb-3">
        Generate a link to invite a new user. Each invite is single-use and expires in 7 days.
      </p>

      <button
        onClick={() => createMut.mutate()}
        disabled={createMut.isPending}
        className="px-3 py-2 rounded-md bg-primary text-surface-950 font-semibold text-xs hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {createMut.isPending ? "Creating…" : "+ Generate invite link"}
      </button>

      {createMut.isError && (
        <p className="text-xs text-danger mt-2">
          {createMut.error?.message || "Failed to create invite"}
        </p>
      )}

      {latestUrl && (
        <div className="mt-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 space-y-1">
          <p className="text-2xs uppercase tracking-wider text-success">New invite link</p>
          <code className="block text-xs break-all text-surface-200">{latestUrl}</code>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(latestUrl)
                .then(() => toast.success("Copied to clipboard"))
                .catch(() => toast.error("Could not copy — copy manually."));
            }}
            className="text-2xs text-success underline underline-offset-2 hover:no-underline"
          >
            Copy to clipboard
          </button>
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-4">
          <h3 className="text-2xs uppercase tracking-wider text-surface-500 mb-2">All invitations</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-surface-500 text-left">
                <th className="py-1.5 pr-2 font-normal">Token</th>
                <th className="py-1.5 pr-2 font-normal">Status</th>
                <th className="py-1.5 pr-2 font-normal">Expires</th>
                <th className="py-1.5 font-normal text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((inv) => {
                const used    = !!inv.used_by;
                const expired = inv.expires_at < now;
                const status  = used ? "used" : expired ? "expired" : "open";
                const statusColor = used    ? "text-surface-500"
                                  : expired ? "text-danger"
                                  : "text-success";
                return (
                  <tr key={inv.token} className="border-t border-surface-800">
                    <td className="py-1.5 pr-2 font-mono text-surface-300">{inv.token.slice(0, 8)}…</td>
                    <td className={clsx("py-1.5 pr-2", statusColor)}>{status}</td>
                    <td className="py-1.5 pr-2 text-surface-400 tabular-nums">
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </td>
                    <td className="py-1.5 text-right">
                      {!used && (
                        <button
                          onClick={() => revokeMut.mutate(inv.token)}
                          disabled={revokeMut.isPending}
                          className="text-2xs text-danger underline underline-offset-2 hover:no-underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
